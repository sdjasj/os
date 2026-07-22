#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

enum { WORKERS = 4, TRANSFERS = 50000 };

typedef struct {
  int id;
  long balance;
  pthread_mutex_t lock;
} Account;

typedef struct {
  Account *left;
  Account *right;
  uint32_t random_state;
} Job;

static void transfer(Account *from, Account *to, long amount) {
  // 所有线程都按账户 id 递增的顺序加锁，消除 ABBA 环路。
  Account *first = from->id < to->id ? from : to;
  Account *second = from->id < to->id ? to : from;
  pthread_mutex_lock(&first->lock);
  pthread_mutex_lock(&second->lock);

  if (from->balance >= amount) {
    from->balance -= amount;
    to->balance += amount;
  }

  pthread_mutex_unlock(&second->lock);
  pthread_mutex_unlock(&first->lock);
}

static uint32_t next_random(uint32_t *state) {
  uint32_t x = *state;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  return *state = x;
}

static void *worker(void *argument) {
  Job *job = argument;
  for (int i = 0; i < TRANSFERS; i++) {
    long amount = (long)(next_random(&job->random_state) % 5 + 1);
    if (next_random(&job->random_state) & 1U) {
      transfer(job->left, job->right, amount);
    } else {
      transfer(job->right, job->left, amount);
    }
  }
  return NULL;
}

int main(void) {
  Account accounts[] = {
      {.id = 0, .balance = 1000, .lock = PTHREAD_MUTEX_INITIALIZER},
      {.id = 1, .balance = 1000, .lock = PTHREAD_MUTEX_INITIALIZER},
  };
  pthread_t threads[WORKERS];
  Job jobs[WORKERS];
  for (int i = 0; i < WORKERS; i++) {
    jobs[i] = (Job){.left = &accounts[0],
                    .right = &accounts[1],
                    .random_state = (uint32_t)(0x12345678U + (unsigned)i)};
    if (pthread_create(&threads[i], NULL, worker, &jobs[i]) != 0) {
      fputs("pthread_create failed\n", stderr);
      return EXIT_FAILURE;
    }
  }
  for (int i = 0; i < WORKERS; i++) {
    pthread_join(threads[i], NULL);
  }
  printf("A=%ld B=%ld total=%ld\n", accounts[0].balance,
         accounts[1].balance, accounts[0].balance + accounts[1].balance);
  return accounts[0].balance + accounts[1].balance == 2000 ? 0 : 1;
}
