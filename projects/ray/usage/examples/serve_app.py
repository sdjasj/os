"""Define a Ray Serve application and make one local HTTP request."""

import json
from urllib.request import urlopen

from ray import serve
from starlette.requests import Request


@serve.deployment(ray_actor_options={"num_cpus": 1})
class Greeter:
    def __init__(self, message: str) -> None:
        self.message = message

    def __call__(self, request: Request) -> dict[str, str]:
        return {
            "message": self.message,
            "path": request.url.path,
        }


# The importable application is usable with:
# serve run ray_usage_guide.examples.serve_app:app
app = Greeter.bind("Hello from Ray Serve")


def main() -> None:
    serve.run(app, route_prefix="/")
    try:
        with urlopen("http://127.0.0.1:8000/", timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))
        print(payload)
    finally:
        serve.shutdown()


if __name__ == "__main__":
    main()
