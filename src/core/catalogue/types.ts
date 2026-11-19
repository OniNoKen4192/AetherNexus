export type ShipJob = "delivery" | "customs" | "transfer" | "survey";

export type Vessel = {
  hull: string;
  count: number;
  role: "lead" | "escort" | "cargo";
};

export type Formation = {
  id: string;
  name: string;
  job: ShipJob;
  weights?: string[];
  factions?: string[];
  vessels: Vessel[];
  art?: string | null;
};

export type ShipFormation = {
  id: string;
  name: string;
  vessels: Vessel[];
  art?: string | null;
};

export type CargoKind = {
  id: string;
  label: string;
  weights?: string[];
};

export type NameRules = {
  pools: Record<string, string[]>;
  patterns: string[];
};

export type Catalogue = {
  weights: string[];
  formations: Formation[];
  cargo: CargoKind[];
  names: Record<string, NameRules>;
};
