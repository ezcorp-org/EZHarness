/**
 * Binders for a gateway fixture that must never bind.
 *
 * `FactoryTrustedValidatorGateway` declares both binders so the scheduler and the acceptance path
 * share one seam. A fixture that only resolves evidence still has to supply them, and refusing is
 * the honest implementation: if a suite ever reaches one, the error names which binder it reached.
 */
export const unboundFactoryValidatorBinders = {
  async bindAttemptInTransaction(): Promise<never> { throw new Error("this fixture never binds a dedicated validator attempt"); },
  async bindTaskAttemptInTransaction(): Promise<never> { throw new Error("this fixture never binds a protected task attempt"); },
};
