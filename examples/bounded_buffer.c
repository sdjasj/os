#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>

enum { CAPACITY = 4, PRODUCERS = 2, ITEMS_PER_PRODUCER = 6 };

typedef struct {
  int items[CAPACITY];
  int head;
  int tail;
  int count;
  pthread_mutex_t lock;
  pthread_cond_t not_empty;
  pthread_cond_t not_full;
} Queue;

static Queue queue = {
    .lock = PTHREAD_MUTEX_INITIALIZER,
    .not_empty = PTHREAD_COND_INITIALIZER,
    .not_full = PTHREAD_COND_INITIALIZER,
};

static void put(int value) {
  pthread_mutex_lock(&queue.lock);
  while (queue.count == CAPACITY) {
    pthread_cond_wait(&queue.not_full, &queue.lock);
  }
  queue.items[queue.tail] = value;
  queue.tail = (queue.tail + 1) % CAPACITY;
  queue.count++;
  pthread_cond_signal(&queue.not_empty);
  pthread_mutex_unlock(&queue.lock);
}

static int get(void) {
  pthread_mutex_lock(&queue.lock);
  while (queue.count == 0) {
    pthread_cond_wait(&queue.not_empty, &queue.lock);
  }
  int value = queue.items[queue.head];
  queue.head = (queue.head + 1) % CAPACITY;
  queue.count--;
  pthread_cond_signal(&queue.not_full);
  pthread_mutex_unlock(&queue.lock);
  return value;
}

static void *producer(void *argument) {
  int id = *(int *)argument;
  for (int i = 0; i < ITEMS_PER_PRODUCER; i++) {
    put(id * 100 + i);
  }
  return NULL;
}

static void *consumer(void *unused) {
  (void)unused;
  long sum = 0;
  for (int i = 0; i < PRODUCERS * ITEMS_PER_PRODUCER; i++) {
    int value = get();
    printf("consume %d\n", value);
    sum += value;
  }
  printf("consumer sum=%ld\n", sum);
  return NULL;
}

int main(void) {
  pthread_t producers[PRODUCERS];
  pthread_t one_consumer;
  int ids[PRODUCERS];

  pthread_create(&one_consumer, NULL, consumer, NULL);
  for (int i = 0; i < PRODUCERS; i++) {
    ids[i] = i + 1;
    pthread_create(&producers[i], NULL, producer, &ids[i]);
  }
  for (int i = 0; i < PRODUCERS; i++) {
    pthread_join(producers[i], NULL);
  }
  pthread_join(one_consumer, NULL);
  return 0;
}
