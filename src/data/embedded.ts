// Spec §3 — the canonical scenarios ship with the build so a reviewer's first
// run is open link → enter name → reviewing. Importing files replaces this set.

import inputYaml from '../../data/input_tier_scenarios.yaml?raw';
import outputYaml from '../../data/output_behavior_scenarios.yaml?raw';

export const EMBEDDED_INPUT_YAML: string = inputYaml;
export const EMBEDDED_OUTPUT_YAML: string = outputYaml;
