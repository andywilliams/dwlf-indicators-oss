export const isSlopeDirectionCompatible = (
  slope: number,
  breakType: 'support_break' | 'resistance_break',
): boolean => {
  if (!Number.isFinite(slope) || slope === 0) {
    return false;
  }

  if (breakType === 'resistance_break') {
    return slope < 0;
  }

  return slope > 0;
};
