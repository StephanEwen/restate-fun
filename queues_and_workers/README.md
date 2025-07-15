# Simplified version of Queue and Worker System

This is a simple example of using Restate, and specifically Virtual Objects, to build
a custom and highly resilient Queue / Worker setup.

* Work is represented as `TaskBundle`s which contain a set of `Task`s. Tasks are assumed to be executed by an external process (like a GPU worker).
* A Tasks produce a `TaskResult` which is a local resource. Those results can be explicitly persisted (checkpoint) but that does not happen by default.
* Multiple [Queues](./src/svcs/queue.ts) can run, queuing `TaskBundles`
* The external process is managed by a "Worker Tracker" which polls work, tracks pending and completed tasks from the bundle, assigns it to the process, heartbeats the process, checkpoints, etc.
