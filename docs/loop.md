# The Loop

`bagel` is an end-to-end path from a proposed task to a human-readable pull request.
Each stage below is a hand-off: something is produced, and a human decides whether it
is good enough to move on.

## task

The supervisor proposes work, but it does not choose it. A human picks from what was
proposed, and the chosen task is claimed so no two runs pick it up at once.

## plan

The task is turned into a plan, written to disk rather than kept in chat. A human
approves that plan, and the approval is what grants permission to build — nothing
downstream starts on an unapproved plan.

## dispatch

A worker is sent to do the approved work in its own git worktree, branched from the
default branch. It cannot touch the main checkout, so its work stays out of the way
until it is reviewed.

## review

An independent reviewer reads the plan and the staged diff. Because the reviewer
starts from the approved plan, it can judge whether the work did what it was asked
to do rather than only whether the diff looks reasonable.

## land

The reviewed work is committed, pushed, and opened as a pull request for a human to
read. Landing is the last hand-off: the pull request is where a human gets the final
say on what actually merges.
