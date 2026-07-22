#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/timerfd.h>
#include <unistd.h>

static int make_timer(long milliseconds, int tag) {
  int fd = timerfd_create(CLOCK_MONOTONIC, TFD_CLOEXEC);
  if (fd < 0) {
    return -1;
  }
  struct itimerspec spec = {
      .it_interval = {.tv_sec = milliseconds / 1000,
                      .tv_nsec = milliseconds % 1000 * 1000000},
      .it_value = {.tv_sec = milliseconds / 1000,
                   .tv_nsec = milliseconds % 1000 * 1000000},
  };
  if (timerfd_settime(fd, 0, &spec, NULL) < 0) {
    close(fd);
    return -1;
  }
  (void)tag;
  return fd;
}

int main(void) {
  int epoll = epoll_create1(EPOLL_CLOEXEC);
  int fast = make_timer(120, 1);
  int slow = make_timer(200, 2);
  if (epoll < 0 || fast < 0 || slow < 0) {
    perror("create epoll/timerfd");
    return EXIT_FAILURE;
  }

  struct epoll_event event = {.events = EPOLLIN};
  event.data.u32 = 1;
  if (epoll_ctl(epoll, EPOLL_CTL_ADD, fast, &event) < 0) {
    perror("epoll_ctl fast");
    return EXIT_FAILURE;
  }
  event.data.u32 = 2;
  if (epoll_ctl(epoll, EPOLL_CTL_ADD, slow, &event) < 0) {
    perror("epoll_ctl slow");
    return EXIT_FAILURE;
  }

  int notifications = 0;
  while (notifications < 6) {
    struct epoll_event ready[2];
    int count = epoll_wait(epoll, ready, 2, -1);
    if (count < 0 && errno == EINTR) {
      continue;
    }
    if (count < 0) {
      perror("epoll_wait");
      return EXIT_FAILURE;
    }
    for (int i = 0; i < count && notifications < 6; i++) {
      int fd = ready[i].data.u32 == 1 ? fast : slow;
      uint64_t expirations;
      if (read(fd, &expirations, sizeof(expirations)) != sizeof(expirations)) {
        perror("read timerfd");
        return EXIT_FAILURE;
      }
      printf("event loop: timer=%s expirations=%llu\n",
             ready[i].data.u32 == 1 ? "fast" : "slow",
             (unsigned long long)expirations);
      notifications++;
    }
  }

  close(slow);
  close(fast);
  close(epoll);
  return 0;
}
