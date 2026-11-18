class HTTPSession extends CurlSession {
  constructor(options={}) {
    super();
    this.options = options;
    this.base_url = undefined;

    this.set_connections(50, 40, 6);
    this.import_cookies();
  }

  import_cookies() {
    if (this.options.enable_cookies) {
      this.cookie_filename = `/cookies_${Math.random()}.txt`;
      if (this.options.cookie_jar) {
        FS.writeFile(this.cookie_filename, this.options.cookie_jar);
      }
    }
  }

  export_cookies() {
    if (!this.cookie_filename) return "";

    try {
      return FS.readFile(this.cookie_filename, {encoding: "utf8"});
    }
    catch (e) {
      if (e.errno === 44) return "";
      throw e;
    }
  }

  close() {
    if (this.cookie_filename) {
      try {
        FS.unlink(this.cookie_filename);
      }
      catch (e) {}
    }
    super.close();
  }

  request_async(url, params, body) {
    return new Promise((resolve, reject) => {
      let http_handle = null;
      let upload_fn = null; // #556 fork: streaming upload (see below)
      let body_ptr = null; 

      let headers_callback = (stream) => {
        let response_json = c_func_str(_http_get_info, [http_handle]);
        let response = this.constructor.create_response(stream, JSON.parse(response_json));
        
        if (params.redirect === "error" && response.status >= 300 && response.status < 400) {
          finish_callback(-2);
          return;
        }
        resolve(response);
      }
      let finish_callback = (error) => {
        if (body_ptr != null) {
          _free(body_ptr);
          body_ptr = null;
        }
        if (upload_fn !== null) {
          Module.removeFunction(upload_fn);
          upload_fn = null;
        }
        if (http_handle == null) {
          //a race condition with aborting requests may lead to this state
          //if the request gets cancelled right before it finishes normally, this function gets called twice
          //fortunately, we can just return here to prevent anything bad from happening
          return;
        }
        if (error > 0) {
          error_msg(`Request "${url}" failed with error code ${error}: ${get_error_str(error)}`);
          reject(new TypeError(`Request failed with error code ${error}: ${get_error_str(error)}`));
        }
        else if (error === -1) {
          reject(new DOMException("The operation was aborted."));
        }
        else if (error === -2) {
          reject(new TypeError("Request failed because redirects were disallowed."));
        }
        this.remove_request(http_handle);
        http_handle = null;
      }
      
      /* #556 fork: streaming upload. params.upload = { read, chunkSize }:
         read(bufPtr, max) is invoked synchronously from inside the
         transfer loop; it writes at most max bytes into the wasm heap
         at bufPtr and returns the count, 0 for EOF, or -1 to pause the
         transfer until the JS side resumes it with _http_pause. Pump
         an async source into a JS-side queue and pause when it runs
         dry. */
      if (params.upload && params.upload.read) {
        const up = params.upload;
        /* #556 fork: the callback receives a Uint8Array view of the wasm
           heap scratch buffer (Module.HEAPU8.subarray, fresh per call so
           memory growth cannot leave a stale view); it writes at most
           max bytes into the view and returns the count. */
        upload_fn = Module.addFunction((bufPtr, max) => up.read(Module.HEAPU8.subarray(bufPtr, bufPtr + max), max) | 0, "iii");
        /* #556 fork resume seam: the caller pumps an async source; when
           read() returns -1 (paused) it refills and calls up.resume() to
           continue the transfer (curl_easy_pause, CURLPAUSE_CONT). The
           handle never leaves this closure; after finish_callback it is
           null and resume() is an honest no-op. */
        up.resume = () => {
          if (http_handle != null) c_func(_http_pause, [http_handle, 0]);
        };
      }
      else {
        body_ptr = body ? allocate_array(body) : null;
      }
      let body_length = body && !(params.upload && params.upload.read) ? body.length : 0;
      let params_json = JSON.stringify(params);
      
      http_handle = this.stream_response(url, headers_callback, finish_callback, params.signal);
      c_func(_http_set_options, [http_handle, params_json, body_ptr, body_length]);
      if (upload_fn !== null) {
        c_func(_http_set_upload_stream, [http_handle, upload_fn, params.upload.chunkSize || 65536, typeof params.upload.contentLength === "number" ? params.upload.contentLength : -1]);
      }
      if (this.cookie_filename && params.credentials !== "omit") {
        c_func(_http_set_cookie_jar, [http_handle, this.cookie_filename]);
      }
      if (params.proxy) {
        c_func_str(_request_set_proxy, [http_handle, params.proxy]);
      }

      this.start_request(http_handle);
    });
  }

  async fetch(resource, params_old={}) {
    let url = resource;
    //shallow copy the original params object
    let params = Object.fromEntries(Object.entries(params_old));

    if (resource instanceof Request) {
      url = resource.url;
      params.headers = params.headers || Object.fromEntries(resource.headers);
      params.method = params.method || resource.method;
      let resource_body = await resource.arrayBuffer();
      if (resource_body.byteLength !== 0) 
        params.body = resource_body;
    }
    else if (typeof url === "string" || url instanceof String) {
      url = (new URL(url, this.base_url)).href;
    }
    else if (url instanceof URL) {
      url = url.href;
    }
    else {
      url = "" + url;
    }

    if (this.options && this.options.proxy) {
      params.proxy = this.options.proxy;
    }
    check_proxy(params.proxy);

    let body = await this.constructor.create_options(params);
    return await this.request_async(url, params, body);
  }

  static create_response(response_data, response_info) {
    response_info.ok = response_info.status >= 200 && response_info.status < 300;
    response_info.statusText = status_messages[response_info.status] || "";
    if (response_info.status === 204 || response_info.status === 205) {
      response_data = null;
    }

    //construct base response object
    let response_obj = new Response(response_data, response_info);
    for (let key in response_info) {
      if (key == "headers") continue;
      Object.defineProperty(response_obj, key, {
        writable: false,
        value: response_info[key]
      });
    }

    //create headers object
    Object.defineProperty(response_obj, "headers", {
      writable: false,
      value: new Headers()
    });
    Object.defineProperty(response_obj, "raw_headers", {
      writable: false,
      value: response_info.headers
    });
    for (let [header_name, header_value] of response_info.headers) {
      response_obj.headers.append(header_name, header_value);
    }

    //hack to fix invalid blob type
    let response_proto = Object.getPrototypeOf(response_obj);
    response_obj.blob = async () => {
      let blob = await response_proto.blob.call(response_obj);
      let mime_type = blob.type.split(";")[0].trim();
      Object.defineProperty(blob, "type", {
        value: mime_type
      });
      return blob;
    }
    
    return response_obj;
  }

  static async create_options(params) {
    let body = null;
    /* #556 fork: a streaming upload must not be materialized. The
       default path pulls the whole body through Request.arrayBuffer()
       into one contiguous Uint8Array before request_async ever runs,
       which is exactly what the upload seam exists to avoid. Build the
       header dict and defaults and keep the body null; request_async
       ignores it when params.upload.read is armed. */
    if (params.upload && params.upload.read) {
      let headers = params.headers || {};
      if (headers instanceof Headers) {
        headers = Object.fromEntries(headers);
      }
      params.headers = new HeadersDict(headers);
      if (params.body instanceof Blob && params.body.type && !params.headers["Content-Type"]) {
        params.headers["Content-Type"] = params.body.type;
      }
      if (!params.headers["User-Agent"]) {
        params.headers["User-Agent"] = navigator.userAgent;
      }
      return null;
    }
    if (params.body instanceof ReadableStream) {
      params.duplex = "half";
    }

    let request_obj = new Request("http://127.0.0.1/", params);
    let array_buffer = await request_obj.arrayBuffer();
    if (array_buffer.byteLength > 0) {
      body = new Uint8Array(array_buffer);
    }
    
    let headers = params.headers || {};
    if (headers instanceof Headers) {
      headers = Object.fromEntries(headers);
    }
    params.headers = new HeadersDict(headers);

    if (params.referrer) {
      params.headers["Referer"] = params.referrer;
    }
    if (!params.headers["User-Agent"]) {
      params.headers["User-Agent"] = navigator.userAgent;
    }
    if (body && !params.headers["Content-Type"]) {
      params.headers["Content-Type"] = request_obj.headers.get("Content-Type") || "";
    }

    return body;
  }
}