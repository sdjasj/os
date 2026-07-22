#include <stdbool.h>
#include <stdio.h>

typedef struct {
  const char *name;
  int pc;
  int acc;
  bool finished;
} Task;

static void step(Task *task) {
  switch (task->pc) {
    case 0:
      task->acc = 1;
      task->pc = 1;
      break;
    case 1:
      task->acc *= 2;
      task->pc = 2;
      break;
    case 2:
      task->acc += 3;
      task->pc = 3;
      break;
    default:
      task->finished = true;
      break;
  }
}

int main(void) {
  Task tasks[] = {
      {.name = "A", .pc = 0, .acc = 0, .finished = false},
      {.name = "B", .pc = 0, .acc = 0, .finished = false},
  };
  const int task_count = (int)(sizeof(tasks) / sizeof(tasks[0]));
  int live = task_count;

  for (int tick = 0; live > 0; tick++) {
    Task *current = &tasks[tick % task_count];
    if (current->finished) {
      continue;
    }

    printf("tick=%d run=%s before(pc=%d, acc=%d)", tick, current->name,
           current->pc, current->acc);
    step(current);  // 像 CPU 一样，只执行一次状态迁移。
    printf(" -> after(pc=%d, acc=%d)\n", current->pc, current->acc);

    if (current->finished) {
      live--;
    }
  }

  puts("scheduler: all tasks finished");
  return 0;
}
