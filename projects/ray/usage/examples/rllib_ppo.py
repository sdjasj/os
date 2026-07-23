"""Run one small PPO training iteration on CartPole."""

from pprint import pprint

from ray.rllib.algorithms.ppo import PPOConfig


def main() -> None:
    config = (
        PPOConfig()
        .environment("CartPole-v1")
        # Keep sampling in the main Algorithm process for a small local example.
        .env_runners(num_env_runners=0)
        .training(lr=3e-4)
    )

    algorithm = config.build_algo()
    try:
        result = algorithm.train()
        print("top-level result keys:")
        pprint(sorted(result.keys()))

        checkpoint_path = algorithm.save_to_path()
        print("checkpoint:", checkpoint_path)
    finally:
        algorithm.stop()


if __name__ == "__main__":
    main()
