"""Keep state in an actor and distribute work across an actor pool."""

import ray


@ray.remote(num_cpus=1)
class Counter:
    def __init__(self) -> None:
        self.value = 0

    def increment(self, amount: int = 1) -> int:
        self.value += amount
        return self.value

    def get(self) -> int:
        return self.value


@ray.remote(num_cpus=1)
class ModelWorker:
    def __init__(self, multiplier: int) -> None:
        # A real actor might load a model or open a connection here.
        self.multiplier = multiplier

    def predict(self, value: int) -> int:
        return value * self.multiplier


def main() -> None:
    ray.init()

    try:
        counter = Counter.remote()
        update_refs = [counter.increment.remote() for _ in range(5)]
        print("counter updates:", ray.get(update_refs))
        print("counter final value:", ray.get(counter.get.remote()))

        workers = [ModelWorker.remote(multiplier=10) for _ in range(2)]
        prediction_refs = [
            workers[index % len(workers)].predict.remote(value)
            for index, value in enumerate(range(8))
        ]
        print("actor-pool predictions:", ray.get(prediction_refs))
    finally:
        ray.shutdown()


if __name__ == "__main__":
    main()
