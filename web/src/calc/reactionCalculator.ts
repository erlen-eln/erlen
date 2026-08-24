// 反応計算（当量・質量・体積・モル数・収率の相互変換）。
// 姉妹アプリ elnectmobile の src/utils/reactionCalculator.ts を無改修で持ち込んだもの。
// 変更したのは1行目の import 先だけ（'../types' → './types.ts'）。
// 実験ノートの数字が合わなくなると致命的なので、ここは触らずに済むよう
// 表側の都合（基準行の伝播・収率）は reactionTable.ts に分けてある。
// 検証は test/reaction-calc.test.mjs（Nodeの型ストリップでこのファイルを直接importしている）。
import type { Molecule } from './types.ts';

export interface CalculationInput {
  molecularWeight: number | null;
  density: number | null;      // g/mL
  purity: number | null;       // % (0-100)
  equivalents: number | null;  // Eq.
  mass: number | null;         // mg
  moles: number | null;        // mmol
  volume: number | null;       // mL
  molarity: number | null;     // mol/L
}

export interface CalculationResult {
  equivalents: number | null;
  mass: number | null;         // mg
  moles: number | null;        // mmol
  volume: number | null;       // mL
}

/**
 * Calculate moles from mass
 * mmol = (mass in mg) / MW
 */
export function calculateMolesFromMass(
  massInMg: number,
  molecularWeight: number,
  purity: number = 100
): number {
  return (massInMg * (purity / 100)) / molecularWeight;
}

/**
 * Calculate mass from moles
 * mass (mg) = mmol * MW
 */
export function calculateMassFromMoles(
  molesInMmol: number,
  molecularWeight: number,
  purity: number = 100
): number {
  return (molesInMmol * molecularWeight) / (purity / 100);
}

/**
 * Calculate volume from mass (for liquids)
 * volume (mL) = mass (mg) / (density (g/mL) * 1000)
 */
export function calculateVolumeFromMass(
  massInMg: number,
  densityGPerMl: number
): number {
  return massInMg / (densityGPerMl * 1000);
}

/**
 * Calculate mass from volume (for liquids)
 * mass (mg) = volume (mL) * density (g/mL) * 1000
 */
export function calculateMassFromVolume(
  volumeInMl: number,
  densityGPerMl: number
): number {
  return volumeInMl * densityGPerMl * 1000;
}

/**
 * Calculate volume from moles (for solutions with molarity)
 * volume (mL) = moles (mmol) / molarity (mol/L)
 */
export function calculateVolumeFromMolesAndMolarity(
  molesInMmol: number,
  molarityMolPerL: number
): number {
  return molesInMmol / molarityMolPerL;
}

/**
 * Calculate moles from volume and molarity
 * moles (mmol) = volume (mL) * molarity (mol/L)
 */
export function calculateMolesFromVolumeAndMolarity(
  volumeInMl: number,
  molarityMolPerL: number
): number {
  return volumeInMl * molarityMolPerL;
}

/**
 * Calculate equivalents based on reference moles
 * Eq. = moles / reference_moles
 */
export function calculateEquivalents(
  molesInMmol: number,
  referenceMolesInMmol: number
): number {
  if (referenceMolesInMmol === 0) return 0;
  return molesInMmol / referenceMolesInMmol;
}

/**
 * Calculate moles from equivalents and reference moles
 * moles (mmol) = Eq. * reference_moles
 */
export function calculateMolesFromEquivalents(
  equivalents: number,
  referenceMolesInMmol: number
): number {
  return equivalents * referenceMolesInMmol;
}

/**
 * Recalculate all molecules based on reference compound
 */
export function recalculateMolecules(
  molecules: Molecule[],
  referenceMolecule: Molecule
): Molecule[] {
  const refMoles = referenceMolecule.moles;

  if (refMoles === null || refMoles === 0) {
    return molecules;
  }

  return molecules.map(mol => {
    if (mol.id === referenceMolecule.id) {
      return { ...mol, equivalents: 1.0 };
    }

    // Calculate moles from equivalents if we have them
    if (mol.equivalents !== null && mol.molecular_weight !== null) {
      const moles = calculateMolesFromEquivalents(mol.equivalents, refMoles);
      const purity = mol.purity ?? 100;
      const mass = calculateMassFromMoles(moles, mol.molecular_weight, purity);

      let volume: number | null = null;
      if (mol.density !== null && mol.density > 0) {
        volume = calculateVolumeFromMass(mass, mol.density);
      } else if (mol.molarity !== null && mol.molarity > 0) {
        volume = calculateVolumeFromMolesAndMolarity(moles, mol.molarity);
      }

      return {
        ...mol,
        moles,
        mass,
        volume,
      };
    }

    return mol;
  });
}

/**
 * Calculate from a specific field change
 */
export type CalculationField = 'mass' | 'moles' | 'volume' | 'equivalents';

export function calculateFromField(
  input: CalculationInput,
  changedField: CalculationField,
  referenceMoles: number | null
): CalculationResult {
  const { molecularWeight, density, purity, molarity } = input;
  const purityValue = purity ?? 100;

  let result: CalculationResult = {
    equivalents: input.equivalents,
    mass: input.mass,
    moles: input.moles,
    volume: input.volume,
  };

  switch (changedField) {
    case 'mass': {
      if (input.mass !== null && molecularWeight !== null && molecularWeight > 0) {
        const moles = calculateMolesFromMass(input.mass, molecularWeight, purityValue);
        result.moles = moles;

        if (referenceMoles !== null && referenceMoles > 0) {
          result.equivalents = calculateEquivalents(moles, referenceMoles);
        }

        if (density !== null && density > 0) {
          result.volume = calculateVolumeFromMass(input.mass, density);
        }
      }
      break;
    }

    case 'moles': {
      if (input.moles !== null && molecularWeight !== null && molecularWeight > 0) {
        const mass = calculateMassFromMoles(input.moles, molecularWeight, purityValue);
        result.mass = mass;

        if (referenceMoles !== null && referenceMoles > 0) {
          result.equivalents = calculateEquivalents(input.moles, referenceMoles);
        }

        if (density !== null && density > 0) {
          result.volume = calculateVolumeFromMass(mass, density);
        } else if (molarity !== null && molarity > 0) {
          result.volume = calculateVolumeFromMolesAndMolarity(input.moles, molarity);
        }
      }
      break;
    }

    case 'volume': {
      if (input.volume !== null) {
        let moles: number | null = null;

        if (density !== null && density > 0) {
          const mass = calculateMassFromVolume(input.volume, density);
          result.mass = mass;

          if (molecularWeight !== null && molecularWeight > 0) {
            moles = calculateMolesFromMass(mass, molecularWeight, purityValue);
            result.moles = moles;
          }
        } else if (molarity !== null && molarity > 0) {
          moles = calculateMolesFromVolumeAndMolarity(input.volume, molarity);
          result.moles = moles;

          if (molecularWeight !== null && molecularWeight > 0) {
            result.mass = calculateMassFromMoles(moles, molecularWeight, purityValue);
          }
        }

        if (moles !== null && referenceMoles !== null && referenceMoles > 0) {
          result.equivalents = calculateEquivalents(moles, referenceMoles);
        }
      }
      break;
    }

    case 'equivalents': {
      if (input.equivalents !== null && referenceMoles !== null && referenceMoles > 0) {
        const moles = calculateMolesFromEquivalents(input.equivalents, referenceMoles);
        result.moles = moles;

        if (molecularWeight !== null && molecularWeight > 0) {
          const mass = calculateMassFromMoles(moles, molecularWeight, purityValue);
          result.mass = mass;

          if (density !== null && density > 0) {
            result.volume = calculateVolumeFromMass(mass, density);
          } else if (molarity !== null && molarity > 0) {
            result.volume = calculateVolumeFromMolesAndMolarity(moles, molarity);
          }
        }
      }
      break;
    }
  }

  return result;
}

/**
 * Format number for display
 */
export function formatNumber(value: number | null, decimals: number = 2): string {
  if (value === null || isNaN(value)) return '-';
  return value.toFixed(decimals);
}
