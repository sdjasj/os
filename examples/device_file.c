#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <unistd.h>

int main(void) {
  int zero = open("/dev/zero", O_RDONLY | O_CLOEXEC);
  if (zero < 0) {
    perror("open /dev/zero");
    return EXIT_FAILURE;
  }

  uint8_t bytes[32];
  if (read(zero, bytes, sizeof(bytes)) != sizeof(bytes)) {
    perror("read /dev/zero");
    return EXIT_FAILURE;
  }
  unsigned sum = 0;
  for (size_t i = 0; i < sizeof(bytes); i++) {
    sum += bytes[i];
  }

  struct stat metadata;
  if (fstat(zero, &metadata) < 0) {
    perror("fstat");
    return EXIT_FAILURE;
  }
  printf("/dev/zero: fd=%d mode=%#o bytes-sum=%u\n", zero,
         metadata.st_mode, sum);
  close(zero);

  struct winsize window;
  if (ioctl(STDOUT_FILENO, TIOCGWINSZ, &window) == 0) {
    printf("terminal ioctl: rows=%u cols=%u\n", window.ws_row, window.ws_col);
  } else {
    puts("stdout is not a terminal; TIOCGWINSZ is unavailable here");
  }
  return 0;
}
