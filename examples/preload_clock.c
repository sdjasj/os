#include <dlfcn.h>
#include <stddef.h>
#include <time.h>

typedef time_t (*time_function)(time_t *);

time_t time(time_t *result) {
  static time_function real_time;
  if (real_time == NULL) {
    *(void **)(&real_time) = dlsym(RTLD_NEXT, "time");
    if (real_time == NULL) {
      return (time_t)-1;
    }
  }

  time_t shifted = real_time(NULL) + 3600;  // 把应用程序的时钟拨快一小时。
  if (result != NULL) {
    *result = shifted;
  }
  return shifted;
}
