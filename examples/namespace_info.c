#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void show_namespace(const char *name) {
  char path[128];
  char target[256];
  snprintf(path, sizeof(path), "/proc/self/ns/%s", name);
  ssize_t length = readlink(path, target, sizeof(target) - 1);
  if (length < 0) {
    printf("%-8s unavailable: %s\n", name, strerror(errno));
    return;
  }
  target[length] = '\0';
  printf("%-8s %s\n", name, target);
}

int main(void) {
  const char *names[] = {"pid", "mnt", "net", "uts", "ipc", "user", "cgroup"};
  printf("pid=%ld namespace identities:\n", (long)getpid());
  for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
    show_namespace(names[i]);
  }

  puts("\n/proc/self/cgroup:");
  FILE *file = fopen("/proc/self/cgroup", "r");
  if (file == NULL) {
    perror("fopen /proc/self/cgroup");
    return EXIT_FAILURE;
  }
  char line[512];
  while (fgets(line, sizeof(line), file) != NULL) {
    fputs(line, stdout);
  }
  fclose(file);
  return 0;
}
