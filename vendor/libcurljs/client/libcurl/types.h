#include "curl/curl.h"

typedef void(*DataCallback)(int request_id, char* chunk_ptr, int chunk_size);
typedef void(*EndCallback)(int request_id, int error);

struct RequestInfo {
  CURL* http_handle;
  struct CURLMsg *curl_msg;
  struct curl_slist* headers_list;
  int request_id;
  DataCallback data_callback;
  DataCallback headers_callback;
  EndCallback end_callback;
  /* #556 fork: streaming upload state. upload_fn is a JS function
     pointer (an emscripten table index registered with addFunction)
     with signature int read(char* buf, int max): it writes at most max
     bytes into buf and returns the count, 0 for EOF, or -1 to pause
     the transfer until the JS side resumes it via http_pause. */
  void* upload_fn;
  char* upload_buf;
  int upload_buf_size;
};

struct WSResult {
  int res;
  int buffer_size;
  int closed;
  int bytes_left;
  int is_text;
  char* buffer;
};

struct SessionInfo {
  CURLM* multi_handle;
  int request_active;
};