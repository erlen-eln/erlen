// モル計算ユーティリティ（mass / volume / mol / mmol の相互変換）。
// 姉妹アプリ elnectmobile の src/utils/molCalculator.ts を無改修で持ち込んだもの。
// 変更したのは1行目の import 先だけ（'../types' → './types.ts'）。
// 反応表は reactionCalculator.ts の方を使う。こちらは単体の換算（molとmmolの往復など）用。
import type { MolCalculation } from './types.ts';

/**
 * モル計算ユーティリティ
 *
 * 関係式:
 * - mol = mass / MW
 * - mol = volume * density / MW (純度補正あり)
 * - mass = mol * MW
 * - volume = mass / density
 */

export function calculateMol(params: {
  molecularWeight: number | null;
  mass?: number | null;
  volume?: number | null;
  density?: number | null;
  purity?: number | null; // 0-100%
}): number | null {
  const { molecularWeight, mass, volume, density, purity } = params;

  if (!molecularWeight || molecularWeight <= 0) return null;

  const purityFactor = purity && purity > 0 ? purity / 100 : 1;

  // Calculate from mass
  if (mass != null && mass > 0) {
    return (mass * purityFactor) / molecularWeight;
  }

  // Calculate from volume and density
  if (volume != null && volume > 0 && density != null && density > 0) {
    const massFromVolume = volume * density;
    return (massFromVolume * purityFactor) / molecularWeight;
  }

  return null;
}

export function calculateMass(params: {
  molecularWeight: number | null;
  mol?: number | null;
  volume?: number | null;
  density?: number | null;
  purity?: number | null;
}): number | null {
  const { molecularWeight, mol, volume, density, purity } = params;

  const purityFactor = purity && purity > 0 ? purity / 100 : 1;

  // Calculate from mol
  if (mol != null && mol > 0 && molecularWeight && molecularWeight > 0) {
    return (mol * molecularWeight) / purityFactor;
  }

  // Calculate from volume and density
  if (volume != null && volume > 0 && density != null && density > 0) {
    return volume * density;
  }

  return null;
}

export function calculateVolume(params: {
  mass?: number | null;
  density?: number | null;
}): number | null {
  const { mass, density } = params;

  if (mass != null && mass > 0 && density != null && density > 0) {
    return mass / density;
  }

  return null;
}

export function molToMmol(mol: number | null): number | null {
  if (mol == null) return null;
  return mol * 1000;
}

export function mmolToMol(mmol: number | null): number | null {
  if (mmol == null) return null;
  return mmol / 1000;
}

export type CalculationField = 'mass' | 'volume' | 'mol' | 'mmol';

/**
 * Calculate all values based on the changed field
 */
export function recalculate(
  current: MolCalculation,
  changedField: CalculationField,
  newValue: number | null
): MolCalculation {
  const result: MolCalculation = { ...current };

  switch (changedField) {
    case 'mass':
      result.mass = newValue;
      result.mol = calculateMol({
        molecularWeight: result.molecularWeight,
        mass: newValue,
        purity: result.purity,
      });
      result.mmol = molToMmol(result.mol);
      result.volume = calculateVolume({
        mass: newValue,
        density: result.density,
      });
      break;

    case 'volume':
      result.volume = newValue;
      if (result.density && newValue) {
        result.mass = newValue * result.density;
        result.mol = calculateMol({
          molecularWeight: result.molecularWeight,
          mass: result.mass,
          purity: result.purity,
        });
        result.mmol = molToMmol(result.mol);
      }
      break;

    case 'mol':
      result.mol = newValue;
      result.mmol = molToMmol(newValue);
      result.mass = calculateMass({
        molecularWeight: result.molecularWeight,
        mol: newValue,
        purity: result.purity,
      });
      if (result.density && result.mass) {
        result.volume = result.mass / result.density;
      }
      break;

    case 'mmol':
      result.mmol = newValue;
      result.mol = mmolToMol(newValue);
      result.mass = calculateMass({
        molecularWeight: result.molecularWeight,
        mol: result.mol,
        purity: result.purity,
      });
      if (result.density && result.mass) {
        result.volume = result.mass / result.density;
      }
      break;
  }

  return result;
}
