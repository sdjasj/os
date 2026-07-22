#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void die(const char *what) {
  perror(what);
  exit(EXIT_FAILURE);
}

static void write_all(int fd, const char *data, size_t length) {
  while (length > 0) {
    ssize_t written = write(fd, data, length);
    if (written < 0 && errno == EINTR) {
      continue;
    }
    if (written < 0) {
      die("write");
    }
    data += written;
    length -= (size_t)written;
  }
}

static int open_parent_directory(const char *path) {
  char copy[PATH_MAX];
  if (snprintf(copy, sizeof(copy), "%s", path) >= (int)sizeof(copy)) {
    errno = ENAMETOOLONG;
    return -1;
  }
  char *slash = strrchr(copy, '/');
  if (slash == NULL) {
    return open(".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  }
  if (slash == copy) {
    slash[1] = '\0';
  } else {
    *slash = '\0';
  }
  return open(copy, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
}

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: %s TARGET TEXT\n", argv[0]);
    return EXIT_FAILURE;
  }

  const char *target = argv[1];
  char temporary[PATH_MAX];
  if (snprintf(temporary, sizeof(temporary), "%s.tmp.XXXXXX", target) >=
      (int)sizeof(temporary)) {
    errno = ENAMETOOLONG;
    die("temporary path");
  }

  int fd = mkstemp(temporary);  // 临时文件必须和目标在同一个文件系统。
  if (fd < 0) {
    die("mkstemp");
  }
  write_all(fd, argv[2], strlen(argv[2]));
  write_all(fd, "\n", 1);
  if (fsync(fd) < 0 || close(fd) < 0) {
    unlink(temporary);
    die("fsync/close temporary");
  }

  // rename 在同一个文件系统内原子替换目录项：读者只会看到旧版或新版。
  if (rename(temporary, target) < 0) {
    unlink(temporary);
    die("rename");
  }

  int directory = open_parent_directory(target);
  if (directory < 0 || fsync(directory) < 0 || close(directory) < 0) {
    die("fsync parent directory");
  }
  printf("durably replaced %s\n", target);
  return 0;
}
