#include <stdio.h>
#include <time.h>

int main(void) {
  time_t now = time(NULL);
  struct tm local;
  if (now == (time_t)-1 || localtime_r(&now, &local) == NULL) {
    perror("time/localtime_r");
    return 1;
  }
  char text[64];
  if (strftime(text, sizeof(text), "%F %T %z", &local) == 0) {
    return 1;
  }
  puts(text);
  return 0;
}
