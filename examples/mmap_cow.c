#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

static void die(const char *what) {
  perror(what);
  exit(EXIT_FAILURE);
}

int main(void) {
  int *private_page = mmap(NULL, 4096, PROT_READ | PROT_WRITE,
                           MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  int *shared_page = mmap(NULL, 4096, PROT_READ | PROT_WRITE,
                          MAP_SHARED | MAP_ANONYMOUS, -1, 0);
  if (private_page == MAP_FAILED || shared_page == MAP_FAILED) {
    die("mmap");
  }
  *private_page = 10;
  *shared_page = 10;
  printf("before fork: private=%p:%d shared=%p:%d\n", (void *)private_page,
         *private_page, (void *)shared_page, *shared_page);
  fflush(stdout);

  pid_t child = fork();
  if (child < 0) {
    die("fork");
  }
  if (child == 0) {
    *private_page = 99;  // 触发 copy-on-write。
    *shared_page = 77;   // 修改的是共同的物理页。
    printf("child:      private=%p:%d shared=%p:%d\n", (void *)private_page,
           *private_page, (void *)shared_page, *shared_page);
    fflush(stdout);
    _exit(0);
  }

  if (waitpid(child, NULL, 0) < 0) {
    die("waitpid");
  }
  printf("parent:     private=%p:%d shared=%p:%d\n", (void *)private_page,
         *private_page, (void *)shared_page, *shared_page);

  if (munmap(private_page, 4096) < 0 || munmap(shared_page, 4096) < 0) {
    die("munmap");
  }
  return 0;
}
