#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

enum { ARENA_SIZE = 4096, ALIGNMENT = 16 };

typedef struct Block {
  size_t size;
  struct Block *next;
  int free;
} Block;

static _Alignas(ALIGNMENT) unsigned char arena[ARENA_SIZE];
static Block *head;

static size_t align_up(size_t value) {
  return (value + ALIGNMENT - 1) & ~(size_t)(ALIGNMENT - 1);
}

static void init_arena(void) {
  head = (Block *)arena;
  head->size = ARENA_SIZE - sizeof(*head);
  head->next = NULL;
  head->free = 1;
}

static void split(Block *block, size_t wanted) {
  if (block->size < wanted + sizeof(Block) + ALIGNMENT) {
    return;
  }
  Block *tail = (Block *)((unsigned char *)(block + 1) + wanted);
  tail->size = block->size - wanted - sizeof(*tail);
  tail->next = block->next;
  tail->free = 1;
  block->size = wanted;
  block->next = tail;
}

static void *toy_alloc(size_t size) {
  if (head == NULL) {
    init_arena();
  }
  size = align_up(size);
  for (Block *block = head; block != NULL; block = block->next) {
    if (block->free && block->size >= size) {
      split(block, size);
      block->free = 0;
      return block + 1;
    }
  }
  return NULL;
}

static void toy_free(void *pointer) {
  if (pointer != NULL) {
    ((Block *)pointer - 1)->free = 1;
  }
}

static ptrdiff_t offset(void *pointer) {
  return (unsigned char *)pointer - arena;
}

int main(void) {
  void *a = toy_alloc(24);
  void *b = toy_alloc(80);
  if (a == NULL || b == NULL) {
    fputs("arena exhausted\n", stderr);
    return EXIT_FAILURE;
  }
  printf("a at arena+%td, b at arena+%td\n", offset(a), offset(b));

  toy_free(a);
  void *c = toy_alloc(16);
  printf("free(a), then alloc(c): c at arena+%td (first-fit reused a)\n",
         offset(c));
  return 0;
}
