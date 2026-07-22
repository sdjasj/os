#include <stdio.h>
#include <stdlib.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static void die(const char *what) {
  perror(what);
  exit(EXIT_FAILURE);
}

int main(void) {
  int channel[2];
  if (pipe(channel) < 0) {
    die("pipe");
  }

  pid_t producer = fork();
  if (producer < 0) {
    die("fork producer");
  }
  if (producer == 0) {
    if (dup2(channel[1], STDOUT_FILENO) < 0) {
      die("dup2 producer");
    }
    close(channel[0]);
    close(channel[1]);
    execlp("printf", "printf", "red\\ngreen\\nblue\\n", (char *)NULL);
    die("exec printf");
  }

  pid_t consumer = fork();
  if (consumer < 0) {
    die("fork consumer");
  }
  if (consumer == 0) {
    if (dup2(channel[0], STDIN_FILENO) < 0) {
      die("dup2 consumer");
    }
    close(channel[0]);
    close(channel[1]);
    execlp("wc", "wc", "-l", (char *)NULL);
    die("exec wc");
  }

  // 父进程若保留写端，wc 永远收不到 EOF。
  close(channel[0]);
  close(channel[1]);
  if (waitpid(producer, NULL, 0) < 0 || waitpid(consumer, NULL, 0) < 0) {
    die("waitpid");
  }
  return 0;
}
