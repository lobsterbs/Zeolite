"""Discover every workflow in worker.workflows and serve them."""

import asyncio

import mistralai.workflows as workflows


async def main() -> None:
    classes = workflows.discover_all_workflows_in_package("worker.workflows")
    print("workflows:", [workflows.get_workflow_definition(c).name for c in classes])
    await workflows.run_worker(classes)


if __name__ == "__main__":
    asyncio.run(main())
