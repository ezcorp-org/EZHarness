import { getDb } from "../db/connection";
import { IncusFeatureService } from "./incus-feature-service";
import { IncusQualificationStore } from "./incus-qualification";
import { IncusAdmissionReadinessService } from "./incus-admission-readiness";

/** One production admission composition for UI lifecycle and private repository workspaces. */
export function configuredIncusFeatureService(): IncusFeatureService {
  const qualifications = new IncusQualificationStore({ db: getDb() });
  return new IncusFeatureService({ admissionReadiness: new IncusAdmissionReadinessService(getDb(), qualifications),
    loadQualification: scope => qualifications.load(scope) });
}
