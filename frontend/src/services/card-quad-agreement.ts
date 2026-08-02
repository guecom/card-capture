import { inspectCardQuad, orderQuad, type Point } from './opencv';

export interface CardQuadAgreement {
  accepted: boolean;
  confidence: number;
  meanCornerDrift: number;
  centroidDrift: number;
  areaRatio: number;
  reason: 'ok' | 'invalid' | 'corner-drift' | 'centroid-drift' | 'area-ratio';
}

export interface CardQuadAgreementConfig {
  maxMeanCornerDrift: number;
  maxCentroidDrift: number;
  minAreaRatio: number;
  maxAreaRatio: number;
}

export const DEFAULT_CARD_QUAD_AGREEMENT_CONFIG: CardQuadAgreementConfig = {
  maxMeanCornerDrift: 0.055,
  maxCentroidDrift: 0.04,
  minAreaRatio: 0.62,
  maxAreaRatio: 1.62,
};

function polygonArea(quad: Point[]): number {
  let twiceArea = 0;
  for (let index = 0; index < quad.length; index += 1) {
    const current = quad[index];
    const next = quad[(index + 1) % quad.length];
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return Math.abs(twiceArea) / 2;
}

function centroid(quad: Point[]): Point {
  return quad.reduce(
    (sum, point) => ({ x: sum.x + point.x / quad.length, y: sum.y + point.y / quad.length }),
    { x: 0, y: 0 },
  );
}

function rejected(
  reason: CardQuadAgreement['reason'],
  meanCornerDrift = Number.POSITIVE_INFINITY,
  centroidDrift = Number.POSITIVE_INFINITY,
  areaRatio = 0,
): CardQuadAgreement {
  return { accepted: false, confidence: 0, meanCornerDrift, centroidDrift, areaRatio, reason };
}

/**
 * A learned-model positive is not a global permission for an OpenCV rectangle.
 * Both detectors must describe the same card, in the same frame, before a quad
 * can reach tracking, the overlay, auto-capture, or perspective correction.
 */
export function agreeCardQuad(
  modelQuad: Point[] | null,
  openCvQuad: Point[] | null,
  frameWidth: number,
  frameHeight: number,
  config: CardQuadAgreementConfig = DEFAULT_CARD_QUAD_AGREEMENT_CONFIG,
): CardQuadAgreement {
  if (!modelQuad || !openCvQuad || frameWidth <= 0 || frameHeight <= 0) return rejected('invalid');
  const modelInspection = inspectCardQuad(modelQuad);
  const openCvInspection = inspectCardQuad(openCvQuad);
  if (!modelInspection.valid || !openCvInspection.valid) return rejected('invalid');

  const model = orderQuad(modelInspection.ordered);
  const openCv = orderQuad(openCvInspection.ordered);
  const diagonal = Math.hypot(frameWidth, frameHeight);
  const meanCornerDrift = model.reduce(
    (total, point, index) => total + Math.hypot(point.x - openCv[index].x, point.y - openCv[index].y),
    0,
  ) / (4 * diagonal);
  const modelCenter = centroid(model);
  const openCvCenter = centroid(openCv);
  const centroidDrift = Math.hypot(modelCenter.x - openCvCenter.x, modelCenter.y - openCvCenter.y) / diagonal;
  const modelArea = polygonArea(model);
  const areaRatio = modelArea > 0 ? polygonArea(openCv) / modelArea : 0;

  if (meanCornerDrift > config.maxMeanCornerDrift) return rejected('corner-drift', meanCornerDrift, centroidDrift, areaRatio);
  if (centroidDrift > config.maxCentroidDrift) return rejected('centroid-drift', meanCornerDrift, centroidDrift, areaRatio);
  if (areaRatio < config.minAreaRatio || areaRatio > config.maxAreaRatio) return rejected('area-ratio', meanCornerDrift, centroidDrift, areaRatio);

  const cornerScore = 1 - meanCornerDrift / config.maxMeanCornerDrift;
  const centroidScore = 1 - centroidDrift / config.maxCentroidDrift;
  const areaScore = areaRatio <= 1
    ? (areaRatio - config.minAreaRatio) / (1 - config.minAreaRatio)
    : (config.maxAreaRatio - areaRatio) / (config.maxAreaRatio - 1);
  const confidence = Math.max(0, Math.min(1, 0.55 * cornerScore + 0.25 * centroidScore + 0.2 * areaScore));
  return { accepted: true, confidence, meanCornerDrift, centroidDrift, areaRatio, reason: 'ok' };
}
