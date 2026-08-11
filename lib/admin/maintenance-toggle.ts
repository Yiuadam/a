/*
  The maintenance button has two independent facts to work with:

    `closed`         what the owner wants the next build to do
    `closedByDeploy` what learners see in the running build

  A failed dispatch leaves those values different. In that case the next
  click must retry the saved choice, not invert it. Keeping that decision in a
  small pure helper makes the client behaviour testable without mounting the
  whole admin console.
*/

export interface MaintenanceToggleState {
  closed: boolean;
  closedByDeploy: boolean;
  deployStarted?: boolean;
}

export function maintenanceDispatchFailed(state: MaintenanceToggleState): boolean {
  return state.closed !== state.closedByDeploy && state.deployStarted === false;
}

export function maintenanceNeedsRetry(state: MaintenanceToggleState): boolean {
  return state.closed !== state.closedByDeploy && state.deployStarted !== true;
}

export function nextMaintenanceClosed(state: MaintenanceToggleState): boolean {
  return maintenanceNeedsRetry(state) ? state.closed : !state.closed;
}

export function maintenanceActionLabel(state: MaintenanceToggleState): string {
  if (maintenanceNeedsRetry(state)) {
    return state.closed ? "Retry closing" : "Retry reopening";
  }
  return state.closed ? "Reopen the site" : "Close the site";
}
