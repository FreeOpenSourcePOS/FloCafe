export function shouldApplyInitialUpdateStatus(receivedLiveUpdateStatus: boolean): boolean {
  return !receivedLiveUpdateStatus;
}
