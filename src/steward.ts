/** The two presentation contexts supported by this slice. */
export type StatusTarget = "command" | "footer";

/** The only journal fact needed to decide ticket-01 status. */
export type ActiveRunProbe = "missing" | "present";

/** The read-only operation owned by the Run Journal adapter. */
export interface RunJournalAdapter {
  probeActive(repositoryRoot: string): ActiveRunProbe;
}

/** Empty adapter slots reserved for later, demonstrated uses. */
export type OpaqueAdapter = Readonly<Record<never, never>>;

/** The request-scoped presentation operation owned by the UI adapter. */
export interface StewardUiAdapter {
  presentStatus(statusView: StatusView, target: StatusTarget): void;
}

/** The complete, deliberately fixed orchestration seam for this ticket. */
export interface StewardDependencies {
  runJournal: RunJournalAdapter;
  herdr: OpaqueAdapter;
  git: OpaqueAdapter;
  process: OpaqueAdapter;
  model: OpaqueAdapter;
  clock: OpaqueAdapter;
  ui: StewardUiAdapter;
}

export interface EmptyFooterView {
  run: "none";
  attentionCount: 0;
  text: "steward: no active Run";
}

export interface ActiveFooterView {
  run: "active";
  attentionCount: 0;
  text: "steward: active Run detected";
}

export interface EmptyStatusView {
  kind: "empty";
  markdown: "No active Steward Run exists in this repository.";
  footer: EmptyFooterView;
}

export interface ActiveStatusView {
  kind: "present";
  markdown: "An active Steward Run was detected. Detailed active status is outside ticket 01.";
  footer: ActiveFooterView;
}

export type StatusView = EmptyStatusView | ActiveStatusView;

/** The ticket-01 orchestration operation. */
export interface Steward {
  status(repositoryRoot: string, target: StatusTarget): StatusView;
}

const EMPTY_STATUS: EmptyStatusView = {
  kind: "empty",
  markdown: "No active Steward Run exists in this repository.",
  footer: {
    run: "none",
    attentionCount: 0,
    text: "steward: no active Run",
  },
};

const PRESENT_STATUS: ActiveStatusView = {
  kind: "present",
  markdown: "An active Steward Run was detected. Detailed active status is outside ticket 01.",
  footer: {
    run: "active",
    attentionCount: 0,
    text: "steward: active Run detected",
  },
};

function buildStatusView(probe: ActiveRunProbe): StatusView {
  return probe === "missing" ? EMPTY_STATUS : PRESENT_STATUS;
}

/** Assemble the plain-function orchestration seam without adding lifecycle machinery. */
export function createSteward({ runJournal, ui }: StewardDependencies): Steward {
  function status(repositoryRoot: string, target: StatusTarget): StatusView {
    const statusView = buildStatusView(runJournal.probeActive(repositoryRoot));
    ui.presentStatus(statusView, target);
    return statusView;
  }

  return { status };
}
