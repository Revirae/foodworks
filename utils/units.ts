/**
 * Unit conversion utilities for client-side display and storage
 */

export type StorageUnit = "kg" | "liter" | "unit";
export type DisplayUnit = "kg" | "g" | "L" | "ml" | "unit";

/**
 * Converts a display unit value to storage unit format
 * @param value The value in display units
 * @param displayUnit The display unit (kg, g, L, ml, or unit)
 * @returns Object with converted value and storage unit
 */
export function convertToStorage(
  value: number,
  displayUnit: DisplayUnit,
): { value: number; unit: StorageUnit } {
  switch (displayUnit) {
    case "kg":
      return { value, unit: "kg" };
    case "g":
      return { value: value / 1000, unit: "kg" };
    case "L":
      return { value, unit: "liter" };
    case "ml":
      return { value: value / 1000, unit: "liter" };
    case "unit":
      return { value, unit: "unit" };
    default:
      // Fallback to unit if unknown
      return { value, unit: "unit" };
  }
}

/**
 * Converts a storage unit value to display unit format
 * @param value The value in storage units
 * @param storageUnit The storage unit (kg, liter, or unit)
 * @returns Object with converted value and display unit
 */
export function convertToDisplay(
  value: number,
  storageUnit: StorageUnit,
): { value: number; unit: DisplayUnit } {
  switch (storageUnit) {
    case "kg":
      // Default to kg, but could be converted to g if needed
      return { value, unit: "kg" };
    case "liter":
      // Default to L, but could be converted to ml if needed
      return { value, unit: "L" };
    case "unit":
      return { value, unit: "unit" };
    default:
      // Fallback to unit if unknown
      return { value, unit: "unit" };
  }
}

/**
 * Converts a storage unit value to a specific display unit
 * @param value The value in storage units
 * @param storageUnit The storage unit (kg, liter, or unit)
 * @param targetDisplayUnit The target display unit
 * @returns The converted value
 */
export function convertStorageToDisplayUnit(
  value: number,
  storageUnit: StorageUnit,
  targetDisplayUnit: DisplayUnit,
): number {
  // First convert to base storage unit if needed
  let baseValue = value;
  let baseStorageUnit = storageUnit;

  // Then convert to target display unit
  if (baseStorageUnit === "kg") {
    if (targetDisplayUnit === "kg") {
      return baseValue;
    } else if (targetDisplayUnit === "g") {
      return baseValue * 1000;
    } else {
      // Incompatible - return original
      return value;
    }
  } else if (baseStorageUnit === "liter") {
    if (targetDisplayUnit === "L") {
      return baseValue;
    } else if (targetDisplayUnit === "ml") {
      return baseValue * 1000;
    } else {
      // Incompatible - return original
      return value;
    }
  } else if (baseStorageUnit === "unit") {
    if (targetDisplayUnit === "unit") {
      return baseValue;
    } else {
      // Incompatible - return original
      return value;
    }
  }

  return value;
}

/**
 * Gets the default display unit for a storage unit
 * @param storageUnit The storage unit
 * @returns The default display unit
 */
export function getDefaultDisplayUnit(storageUnit: StorageUnit): DisplayUnit {
  switch (storageUnit) {
    case "kg":
      return "kg";
    case "liter":
      return "L";
    case "unit":
      return "unit";
    default:
      return "unit";
  }
}

/**
 * Converts a value from one display unit to another
 * @param value The value to convert
 * @param fromUnit The source display unit
 * @param toUnit The target display unit
 * @returns The converted value
 */
export function convertBetweenDisplayUnits(
  value: number,
  fromUnit: DisplayUnit,
  toUnit: DisplayUnit,
): number {
  if (fromUnit === toUnit) {
    return value;
  }

  // Direct conversions between compatible units
  if (fromUnit === "kg" && toUnit === "g") {
    return value * 1000;
  }
  if (fromUnit === "g" && toUnit === "kg") {
    return value / 1000;
  }
  if (fromUnit === "L" && toUnit === "ml") {
    return value * 1000;
  }
  if (fromUnit === "ml" && toUnit === "L") {
    return value / 1000;
  }

  // Convert via storage unit for other conversions
  // First convert fromUnit -> storage unit -> toUnit
  const { value: storageValue, unit: storageUnit } = convertToStorage(value, fromUnit);
  const convertedValue = convertStorageToDisplayUnit(storageValue, storageUnit, toUnit);
  
  // If the conversion resulted in the same value (incompatible units), return original
  // This handles cases like kg -> L or unit -> kg
  if (convertedValue === value && fromUnit !== toUnit) {
    // Check if units are in the same family
    const fromFamily = (fromUnit === "kg" || fromUnit === "g") ? "mass" : 
                      (fromUnit === "L" || fromUnit === "ml") ? "volume" : "unit";
    const toFamily = (toUnit === "kg" || toUnit === "g") ? "mass" : 
                    (toUnit === "L" || toUnit === "ml") ? "volume" : "unit";
    
    // If different families, return original (incompatible)
    if (fromFamily !== toFamily) {
      return value;
    }
  }

  return convertedValue;
}

