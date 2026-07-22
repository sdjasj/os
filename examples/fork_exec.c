#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static void die(const char *what) {
  perror(what);
  exit(EXIT_FAILURE);
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--child") == 0) {
    printf("child after exec: pid=%ld ppid=%ld\n", (long)getpid(),
           (long)getppid());
    return 7;
  }

  char self[PATH_MAX];
  ssize_t length = readlink("/proc/self/exe", self, sizeof(self) - 1);
  if (length < 0) {
    die("readlink /proc/self/exe");
  }
  self[length] = '\0';

  printf("parent before fork: pid=%ld\n", (long)getpid());
  fflush(stdout);  // 避免 stdio 缓冲区被 fork 后打印两次。

  pid_t child = fork();
  if (child < 0) {
    die("fork");
  }
  if (child == 0) {
    execl(self, self, "--child", (char *)NULL);
    fprintf(stderr, "exec %s: %s\n", self, strerror(errno));
    _exit(127);  // exec 失败后不要走父进程的清理逻辑。
  }

  int status;
  if (waitpid(child, &status, 0) < 0) {
    die("waitpid");
  }
  if (WIFEXITED(status)) {
    printf("parent reaped child=%ld, exit=%d\n", (long)child,
           WEXITSTATUS(status));
  } else if (WIFSIGNALED(status)) {
    printf("child killed by signal %d\n", WTERMSIG(status));
  }
  return 0;
}
