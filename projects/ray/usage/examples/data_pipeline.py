"""Build and execute a small lazy Ray Data pipeline."""

from typing import Dict

import numpy as np
import ray


def add_features(batch: Dict[str, np.ndarray]) -> Dict[str, np.ndarray]:
    values = batch["id"]
    return {
        "id": values,
        "square": values**2,
        "is_multiple_of_four": values % 4 == 0,
    }


def main() -> None:
    ray.init()

    try:
        dataset = ray.data.range(20, override_num_blocks=4)
        result = (
            dataset.filter(lambda row: row["id"] % 2 == 0)
            .map_batches(
                add_features,
                batch_format="numpy",
                batch_size=5,
            )
        )

        # take_all is safe only because this tutorial dataset is deliberately tiny.
        print(result.take_all())
    finally:
        ray.shutdown()


if __name__ == "__main__":
    main()
