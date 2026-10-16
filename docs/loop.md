# The bagel loop

bagel takes a change from an idea to a reviewable pull request through five stages.
Each stage hands off to the next, and no stage is skipped.

## task

The supervisor proposes work as tasks. A human picks one of the proposed tasks, and
that task is then claimed for the run. Nothing proceeds until a task is claimed.

## plan

A plan is written to disk for the claimed task. A human approves the plan, and that
approval is what grants permission to continue. Without approval, no work begins.

## dispatch

dispatch sends a worker to carry out the approved plan. The worker runs in its own git
worktree, branched from the default branch, so its changes stay isolated.

## review

review is independent of the worker. A reviewer reads the plan and the staged diff,
checking the work against what was approved rather than taking the worker's word for it.

## land

land turns reviewed work into a commit and a push. It opens a pull request so a human
can read the change before it merges.
