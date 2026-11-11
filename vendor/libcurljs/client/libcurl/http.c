#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>

#include "cjson/cJSON.h"
#include "curl/curl.h"

#include "types.h"
#include "util.h"

void http_set_options(CURL* http_handle, const char* json_params, const char* body, int body_length) {
  struct RequestInfo *request_info = get_request_info(http_handle);

  //some default options
  curl_easy_setopt(http_handle, CURLOPT_FOLLOWLOCATION, 1);
  curl_easy_setopt(http_handle, CURLOPT_ACCEPT_ENCODING, "");
  curl_easy_setopt(http_handle, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_2_0);
  curl_easy_setopt(http_handle, CURLOPT_IGNORE_ONION, 1L);

  //parse json options
  cJSON* request_json = cJSON_Parse(json_params);
  cJSON* item = NULL;
  struct curl_slist* headers_list = NULL;

  cJSON_ArrayForEach(item, request_json) {
    char* key = item->string;

    if (strcmp(key, "_libcurl_verbose") == 0) {
      curl_easy_setopt(http_handle, CURLOPT_VERBOSE, 1L);
    }

    if (strcmp(key, "_libcurl_http_version") == 0) {
      if (!cJSON_IsNumber(item)) continue;
      if (item->valuedouble == 1.0) {
        curl_easy_setopt(http_handle, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_1_0);
      }
      else if (item->valuedouble == 1.1) {
        curl_easy_setopt(http_handle, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_1_1);
      }
      else if (item->valuedouble == 2.0) {
        curl_easy_setopt(http_handle, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_2_0);
      }
    }

    if (strcmp(key, "method") == 0 && cJSON_IsString(item)) {
      curl_easy_setopt(http_handle, CURLOPT_CUSTOMREQUEST, item->valuestring);
    }
    
    if (strcmp(key, "headers") == 0 && cJSON_IsObject(item)) {
      cJSON* header = NULL;

      cJSON_ArrayForEach(header, item) {
        if (!cJSON_IsString(header)) continue;
        int header_length = strlen(header->string) + strlen(header->valuestring) + 2;
        char* header_str = malloc(header_length+1);
        header_str[header_length] = 0;

        sprintf(header_str, "%s: %s", header->string, header->valuestring);
        headers_list = curl_slist_append(headers_list, header_str);
        free(header_str);
      }

      curl_easy_setopt(http_handle, CURLOPT_HTTPHEADER, headers_list);
    }

    if (strcmp(key, "redirect") == 0 && cJSON_IsString(item)) {
      if (strcmp(item->valuestring, "error") == 0 || strcmp(item->valuestring, "manual") == 0) {
        curl_easy_setopt(http_handle, CURLOPT_FOLLOWLOCATION, 0);
      }
    }
  }
  cJSON_Delete(request_json);

  //add post data if specified
  if (body != NULL) {
    curl_easy_setopt(http_handle, CURLOPT_POSTFIELDS, body);
    curl_easy_setopt(http_handle, CURLOPT_POSTFIELDSIZE, body_length);
  }

  request_info->headers_list = headers_list;
}

/* #556 fork: streaming upload. Instead of one contiguous
   CURLOPT_POSTFIELDS buffer, the JS side registers a read callback
   (see types.h) and curl pulls chunks through upload_read_callback
   while the transfer loop runs. A -1 return pauses the transfer
   (CURL_READFUNC_PAUSE) so the JS side can refill asynchronously and
   resume it with http_pause; this keeps the callback synchronous and
   therefore works with the non-blocking multi loop libcurl.js runs. */
typedef int (*js_upload_read_fn)(char* buf, int max);

static size_t upload_read_callback(char* buffer, size_t size, size_t nitems, void* arg) {
  struct RequestInfo* request_info = (struct RequestInfo*) arg;
  if (request_info->upload_fn == NULL || request_info->upload_buf == NULL) return 0;
  size_t max_bytes = size * nitems;
  if (max_bytes > (size_t) request_info->upload_buf_size)
    max_bytes = (size_t) request_info->upload_buf_size;
  if (max_bytes == 0) return 0;
  int n = ((js_upload_read_fn) request_info->upload_fn)(request_info->upload_buf, (int) max_bytes);
  if (n == -1) return (size_t) CURL_READFUNC_PAUSE;
  if (n <= 0) return 0;
  if ((size_t) n > max_bytes) n = (int) max_bytes;
  memcpy(buffer, request_info->upload_buf, (size_t) n);
  return (size_t) n;
}

void http_set_upload_stream(CURL* http_handle, int js_fn, int chunk_size) {
  struct RequestInfo* request_info = get_request_info(http_handle);
  request_info->upload_fn = (void*) (intptr_t) js_fn;
  if (request_info->upload_buf == NULL || request_info->upload_buf_size < chunk_size) {
    free(request_info->upload_buf);
    request_info->upload_buf = malloc(chunk_size);
  }
  request_info->upload_buf_size = chunk_size;
  curl_easy_setopt(http_handle, CURLOPT_READFUNCTION, upload_read_callback);
  curl_easy_setopt(http_handle, CURLOPT_READDATA, request_info);
  curl_easy_setopt(http_handle, CURLOPT_UPLOAD, 1L);
  curl_easy_setopt(http_handle, CURLOPT_INFILESIZE_LARGE, (curl_off_t) -1);
}

void http_pause(CURL* http_handle, int bits) {
  curl_easy_pause(http_handle, bits);
}

void http_set_cookie_jar(CURL* http_handle, const char* filename) {
  curl_easy_setopt(http_handle, CURLOPT_COOKIEFILE, filename);
  curl_easy_setopt(http_handle, CURLOPT_COOKIEJAR, filename);
}

char* http_get_info(CURL* http_handle) {
  struct RequestInfo *request_info = get_request_info(http_handle);

  //create new json object with response info
  cJSON* response_json = cJSON_CreateObject();

  long response_code;
  curl_easy_getinfo(http_handle, CURLINFO_RESPONSE_CODE, &response_code);
  cJSON* status_item = cJSON_CreateNumber(response_code);
  cJSON_AddItemToObject(response_json, "status", status_item);

  char* response_url;
  curl_easy_getinfo(http_handle, CURLINFO_EFFECTIVE_URL, &response_url);
  cJSON* url_item = cJSON_CreateString(response_url);
  cJSON_AddItemToObject(response_json, "url", url_item);

  cJSON* headers_item = cJSON_CreateArray();
  struct curl_header *prev_header = NULL;
  struct curl_header *header = NULL;
  while ((header = curl_easy_nextheader(http_handle, CURLH_HEADER, -1, prev_header))) {
    cJSON* header_key_entry = cJSON_CreateString(header->name);
    cJSON* header_value_entry = cJSON_CreateString(header->value);
    cJSON* header_pair_item = cJSON_CreateArray();
    cJSON_AddItemToArray(header_pair_item, header_key_entry);
    cJSON_AddItemToArray(header_pair_item, header_value_entry);
    cJSON_AddItemToArray(headers_item, header_pair_item);
    prev_header = header;
  }
  cJSON_AddItemToObject(response_json, "headers", headers_item);

  long redirect_count;
  curl_easy_getinfo(http_handle, CURLINFO_REDIRECT_COUNT, &redirect_count);
  cJSON* redirects_item = cJSON_CreateBool(redirect_count > 0);
  cJSON_AddItemToObject(response_json, "redirected", redirects_item);

  char* response_json_str = cJSON_Print(response_json);
  cJSON_Delete(response_json);

  return response_json_str;
}

//the address sanitizer falsely flags any malloc operation as a memory leak
const char* __asan_default_options() { return "detect_leaks=false"; }