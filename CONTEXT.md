# Pi Herdr Steward

Pi Herdr Steward coordinates agent work through Herdr while preserving enough durable evidence to recover safely when conversational context or controller availability is interrupted.

## Language

**Steward**:
The coordinator responsible for advancing verified agent work through its required lifecycle.
_Avoid_: Supervisor, scheduler, project manager

**Run**:
One durable orchestration lifecycle containing the work required to reach a declared outcome.
_Avoid_: Session, job

**Task**:
A required outcome within a Run, independent of any particular execution.
_Avoid_: Prompt, agent job

**Attempt**:
One execution of a Task by an assigned agent.
_Avoid_: Task, retry

**Assignment**:
The association between an Attempt and its named Herdr agent, pane, and working location.
_Avoid_: Worker

**Builder**:
The assigned role that produces an Artifact for a Task.
_Avoid_: Implementer, worker

**Reviewer**:
The independent assigned role that evaluates a specific Artifact or Git revision.
_Avoid_: Checker, approver

**Run Journal**:
The durable workflow record used to recover a Run and determine what action remains necessary.
_Avoid_: Transcript, agent memory

**Controller Session**:
The single Pi session currently authorized to advance an active Run.
_Avoid_: Owner process, leader

**Artifact**:
Durable evidence produced by an Attempt, such as a file, diff, commit, or verification result.
_Avoid_: Response, claim

**Attempt Report**:
The durable record through which an agent declares an Attempt's status, Artifacts, revision, checks, and blockers.
_Avoid_: Transcript, final response, result file

**Review**:
An evaluation of a specific immutable Artifact or Git revision.
_Avoid_: Feedback

**Approval**:
A positive Review decision that applies only to the exact revision evaluated.
_Avoid_: Done, accepted generally

**Reconciliation**:
The act of deriving the Run's current truth from the Run Journal, Herdr's live state, and durable Artifacts.
_Avoid_: Status check, polling

**Completion Gate**:
The required evidence and invariants that must hold before a Run can be declared complete.
_Avoid_: Agent finished, idle
