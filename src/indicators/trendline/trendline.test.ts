import { describe, expect, it } from 'vitest';

import type { Candle } from '../../types';
import { computeTrendlines, detectEvents, getEventDefinitions, type TrendlineBreachEventPayload } from './trendline';
import { computeTrendlinesV1, detectEvents as detectEventsV1 } from './trendline.v1';
import { isSlopeDirectionCompatible } from './slopeGuards';

const toTimestamp = (base: Date, days: number): number => {
  const date = new Date(base);
  date.setDate(date.getDate() + days);
  return date.getTime();
};

const buildMarketData = ({ withBreak = false } = {}): Candle[] => {
  const baseDate = new Date('2024-01-01T00:00:00Z');
  const template = [
    130, 132, 134, 136, 138, 100, 112, 118, 124, 130, 136, 142, 110, 118, 126, 134, 142, 150, 158, 166,
    174, 182, 190,
  ];

  return template.map((closeBase, index) => {
    let close = closeBase;
    let low = close - 1.2;
    let high = close + 1.2;
    let open = close - 0.6;

    if (withBreak && index >= template.length - 3) {
      close = closeBase - 160;
      low = close - 1.6;
      high = close + 1.2;
      open = close - 0.6;
    }

    return {
      t: toTimestamp(baseDate, index),
      o: open,
      h: high,
      l: low,
      c: close,
    };
  });
};

const buildResistanceData = (): Candle[] => {
  const baseDate = new Date('2024-04-01T00:00:00Z');
  const highs = [300, 320, 310, 315, 305, 300, 290, 295, 280, 275, 270];

  return highs.map((high, index) => {
    const close = high - 1.4;
    return {
      t: toTimestamp(baseDate, index),
      o: close + 0.3,
      h: high,
      l: close - 1.0,
      c: close,
    };
  });
};

const findSupportLines = (trendlines: ReturnType<typeof computeTrendlines>['trendlines']) =>
  trendlines.filter((line) => line.type === 'support');

const findResistanceLines = (trendlines: ReturnType<typeof computeTrendlines>['trendlines']) =>
  trendlines.filter((line) => line.type === 'resistance');

type RawCandle = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

const buildCandlesFromRaw = (raw: RawCandle[]): Candle[] =>
  raw.map((entry) => ({
    t: new Date(`${entry.date}T00:00:00Z`).getTime(),
    o: entry.open,
    h: entry.high,
    l: entry.low,
    c: entry.close,
  }));

const btcUsdSlice: RawCandle[] = [
  { date: '2025-01-28', open: 102063.92, high: 103770.85, low: 100213.8, close: 101290 },
  { date: '2025-01-29', open: 101290.01, high: 104829.64, low: 101275.6, close: 103747.25 },
  { date: '2025-01-30', open: 103747.25, high: 106484.77, low: 103289.74, close: 104742.64 },
  { date: '2025-01-31', open: 104742.63, high: 106090, low: 101506, close: 102411.26 },
  { date: '2025-02-01', open: 102414.05, high: 102781.65, low: 100250, close: 100623.85 },
  { date: '2025-02-02', open: 100623.88, high: 101459.84, low: 96179, close: 97676.52 },
  { date: '2025-02-03', open: 97676.53, high: 102599.85, low: 91178.01, close: 101460.2 },
  { date: '2025-02-04', open: 101460.15, high: 101812.23, low: 96145.76, close: 97795.05 },
  { date: '2025-02-05', open: 97795.06, high: 99230.49, low: 96161.01, close: 96638.33 },
  { date: '2025-02-06', open: 96635.62, high: 99182.15, low: 95674.96, close: 96564.62 },
  { date: '2025-02-07', open: 96575.24, high: 100235.79, low: 95614.96, close: 96537.08 },
  { date: '2025-02-08', open: 96536.93, high: 96919.05, low: 95682.33, close: 96476.25 },
  { date: '2025-02-09', open: 96476.24, high: 97342.28, low: 94730.67, close: 96475.82 },
  { date: '2025-02-10', open: 96481.47, high: 98367.23, low: 95257.2, close: 97444.41 },
  { date: '2025-02-11', open: 97451.66, high: 98500, low: 94831.07, close: 95774.08 },
  { date: '2025-02-12', open: 95770.95, high: 98119.98, low: 94066.92, close: 97862.53 },
  { date: '2025-02-13', open: 97864.28, high: 98100, low: 95220, close: 96625.29 },
  { date: '2025-02-14', open: 96625.29, high: 98890.11, low: 96268.56, close: 97509.03 },
  { date: '2025-02-15', open: 97507.94, high: 97997.85, low: 97225.01, close: 97596.94 },
  { date: '2025-02-16', open: 97596.54, high: 97738.22, low: 96057.68, close: 96119.88 },
  { date: '2025-02-17', open: 96119.88, high: 97050.64, low: 95200, close: 95781.8 },
  { date: '2025-02-18', open: 95781.8, high: 96730, low: 93333, close: 95607.4 },
  { date: '2025-02-19', open: 95612.97, high: 96880, low: 95000.01, close: 96632.03 },
  { date: '2025-02-20', open: 96632.03, high: 98768.54, low: 96419.07, close: 98347.2 },
  { date: '2025-02-21', open: 98347.2, high: 99517.52, low: 94721.92, close: 96157.03 },
  { date: '2025-02-22', open: 96157.03, high: 96982.52, low: 95767.95, close: 96582.12 },
  { date: '2025-02-23', open: 96578.49, high: 96679.93, low: 95243.91, close: 96265.98 },
  { date: '2025-02-24', open: 96266.23, high: 96515.41, low: 91300, close: 91510.82 },
  { date: '2025-02-25', open: 91509.88, high: 92549.99, low: 85836.18, close: 88583.74 },
  { date: '2025-02-26', open: 88583.17, high: 89305.68, low: 82111.12, close: 84111.78 },
  { date: '2025-02-27', open: 84111.77, high: 86993.87, low: 82554.11, close: 84625.19 },
  { date: '2025-02-28', open: 84627.5, high: 85116.19, low: 78167.81, close: 84297.73 },
  { date: '2025-03-01', open: 84297.74, high: 86534.96, low: 83772.54, close: 86018.76 },
  { date: '2025-03-02', open: 86018.82, high: 95128.88, low: 85003.35, close: 94265.48 },
  { date: '2025-03-03', open: 94265.47, high: 94415.61, low: 85007.01, close: 86161.1 },
  { date: '2025-03-04', open: 86161.09, high: 88977.27, low: 81444, close: 87249.96 },
  { date: '2025-03-05', open: 87247.93, high: 91000, low: 86329.22, close: 90603.73 },
  { date: '2025-03-06', open: 90607.73, high: 92817.29, low: 87790.5, close: 89921.85 },
  { date: '2025-03-07', open: 89915.02, high: 91280, low: 84608.27, close: 86756.98 },
  { date: '2025-03-08', open: 86753.3, high: 86863.38, low: 85200, close: 86206.69 },
  { date: '2025-03-09', open: 86206.64, high: 86480, low: 80000, close: 80699.17 },
  { date: '2025-03-10', open: 80708.21, high: 84033.66, low: 77389, close: 78544.71 },
  { date: '2025-03-11', open: 78534.67, high: 83600, low: 76555, close: 82914.51 },
  { date: '2025-03-12', open: 82911.81, high: 84442.69, low: 80572.21, close: 83659.43 },
  { date: '2025-03-13', open: 81071.5, high: 84310.8, low: 79890, close: 81073.43 },
  { date: '2025-03-14', open: 81071.5, high: 85318.61, low: 80771.17, close: 83980.49 },
  { date: '2025-03-15', open: 83989.86, high: 84690.43, low: 83612.24, close: 84351.46 },
  { date: '2025-03-16', open: 84351.45, high: 85092.35, low: 81969.44, close: 82562.57 },
  { date: '2025-03-17', open: 82575.23, high: 84758.46, low: 82416.98, close: 84011.4 },
  { date: '2025-03-18', open: 84011.39, high: 84029.67, low: 81125, close: 82698.76 },
  { date: '2025-03-19', open: 82699.53, high: 87045.45, low: 82535.53, close: 86877.96 },
  { date: '2025-03-20', open: 86877.97, high: 87492.87, low: 83596.75, close: 84183.42 },
  { date: '2025-03-21', open: 84183.41, high: 84809.72, low: 83100, close: 84061.96 },
  { date: '2025-03-22', open: 84061.96, high: 84517.75, low: 83659.69, close: 83852.03 },
  { date: '2025-03-23', open: 83852.06, high: 86128.99, low: 83804.67, close: 86092.94 },
  { date: '2025-03-24', open: 86092.95, high: 88804.64, low: 85533.06, close: 87523.62 },
  { date: '2025-03-25', open: 87518.09, high: 88584.34, low: 86321.97, close: 87427.88 },
  { date: '2025-03-26', open: 87432.82, high: 88304.1, low: 85850, close: 86926.01 },
  { date: '2025-03-27', open: 86926.01, high: 87790.12, low: 85784, close: 87217.48 },
  { date: '2025-03-28', open: 87214.07, high: 87498.15, low: 83533.4, close: 84381.8 },
  { date: '2025-03-29', open: 84381.81, high: 84584.13, low: 81608.99, close: 82616.83 },
  { date: '2025-03-30', open: 82624.06, high: 83508.98, low: 81538.88, close: 82379.98 },
  { date: '2025-03-31', open: 82379.98, high: 83920.8, low: 81265.16, close: 82534.32 },
  { date: '2025-04-01', open: 82534.31, high: 85566.53, low: 82403.32, close: 85170.37 },
  { date: '2025-04-02', open: 85166.92, high: 88530, low: 82283.01, close: 82490.08 },
  { date: '2025-04-03', open: 82490.1, high: 83953.45, low: 81177.7, close: 83174.33 },
  { date: '2025-04-04', open: 83178.68, high: 84720.67, low: 81643.54, close: 83857.99 },
  { date: '2025-04-05', open: 83859.78, high: 84238.35, low: 82346.61, close: 83498.25 },
  { date: '2025-04-06', open: 83505.88, high: 83773.58, low: 77058.99, close: 78370.75 },
  { date: '2025-04-07', open: 78370.15, high: 81223.67, low: 74420.69, close: 79140.01 },
  { date: '2025-04-08', open: 79140.02, high: 80849.98, low: 76167.35, close: 76251.64 },
  { date: '2025-04-09', open: 76258.8, high: 83583.35, low: 74553.01, close: 82594.75 },
  { date: '2025-04-10', open: 82593.15, high: 82730.93, low: 78387.24, close: 79552.34 },
  { date: '2025-04-11', open: 79552.34, high: 84299, low: 78919.94, close: 83380.47 },
  { date: '2025-04-12', open: 83379.64, high: 85909.97, low: 82765.26, close: 85271.01 },
  { date: '2025-04-13', open: 85271.02, high: 86092.99, low: 83010, close: 83733.07 },
  { date: '2025-04-14', open: 83733.07, high: 85818.06, low: 83655.27, close: 84590.36 },
  { date: '2025-04-15', open: 84590.36, high: 86491.4, low: 83592.77, close: 83629.78 },
  { date: '2025-04-16', open: 83622.52, high: 85526.4, low: 83088.02, close: 84028.72 },
  { date: '2025-04-17', open: 84028.71, high: 85494.94, low: 83711.69, close: 84961.97 },
  { date: '2025-04-18', open: 84961.97, high: 85150.94, low: 84287.06, close: 84466.47 },
  { date: '2025-04-19', open: 84466.47, high: 85625, low: 84353.45, close: 85074.99 },
  { date: '2025-04-20', open: 85074.59, high: 85319.21, low: 83972.82, close: 85177.34 },
  { date: '2025-04-21', open: 85177.33, high: 88575.62, low: 85135.98, close: 87522.07 },
  { date: '2025-04-22', open: 87513.53, high: 93952.62, low: 87077.17, close: 93489.1 },
  { date: '2025-04-23', open: 93486.57, high: 94686, low: 91902.19, close: 93740.92 },
  { date: '2025-04-24', open: 93740.93, high: 94061.02, low: 91685.18, close: 94021.96 },
  { date: '2025-04-25', open: 94021.97, high: 95976.34, low: 92880.01, close: 94708.79 },
  { date: '2025-04-26', open: 94707.79, high: 95273.52, low: 93903.01, close: 94666.64 },
  { date: '2025-04-27', open: 94666.64, high: 95351.11, low: 93654.77, close: 93780.57 },
  { date: '2025-04-28', open: 93780.56, high: 95652.66, low: 92829.44, close: 95042.57 },
  { date: '2025-04-29', open: 95042.56, high: 95499, low: 93761.26, close: 94271.09 },
  { date: '2025-04-30', open: 94271.08, high: 95263.74, low: 92911.88, close: 94182.54 },
  { date: '2025-05-01', open: 94182.55, high: 97546.99, low: 94136.79, close: 96524.98 },
  { date: '2025-05-02', open: 96524.98, high: 97948.56, low: 96369.69, close: 96929.81 },
  { date: '2025-05-03', open: 96929.81, high: 96974.78, low: 95765.13, close: 95861.33 },
  { date: '2025-05-04', open: 95865.47, high: 96312.51, low: 94151.67, close: 94272.55 },
  { date: '2025-05-05', open: 94272.54, high: 95218.82, low: 93500.01, close: 94733.99 },
  { date: '2025-05-06', open: 94733.99, high: 96916.25, low: 93363.28, close: 96839.17 },
  { date: '2025-05-07', open: 96843.84, high: 97738.05, low: 95800, close: 97058.32 },
  { date: '2025-05-08', open: 97058.33, high: 104176.05, low: 96888.25, close: 103253.49 },
  { date: '2025-05-09', open: 103252.2, high: 104352.6, low: 102330.76, close: 102986.96 },
  { date: '2025-05-10', open: 102986.94, high: 104997, low: 102831.41, close: 104821.19 },
  { date: '2025-05-11', open: 104817.83, high: 104980.89, low: 103360.22, close: 104137.62 },
  { date: '2025-05-12', open: 104137.58, high: 105787.37, low: 100703.71, close: 102800.21 },
  { date: '2025-05-13', open: 102800.22, high: 105038.53, low: 101447.78, close: 104131.06 },
  { date: '2025-05-14', open: 104131.2, high: 104373, low: 102603.27, close: 103545.38 },
  { date: '2025-05-15', open: 103540.91, high: 104200, low: 101400.01, close: 103786.43 },
  { date: '2025-05-16', open: 103500.03, high: 103741.98, low: 103125.51, close: 103500.03 },
  { date: '2025-05-17', open: 103500.03, high: 103741.98, low: 102612, close: 103161.07 },
  { date: '2025-05-18', open: 103162.53, high: 106692.97, low: 103130.95, close: 106473.46 },
  { date: '2025-05-19', open: 106488.77, high: 107137.68, low: 102105, close: 105616.18 },
  { date: '2025-05-20', open: 105616.21, high: 107355, low: 104209.18, close: 106883.24 },
  { date: '2025-05-21', open: 106883.24, high: 110788.98, low: 106128.14, close: 109699.54 },
  { date: '2025-05-22', open: 109697.19, high: 112000, low: 109217.23, close: 111722.53 },
  { date: '2025-05-23', open: 111722.54, high: 109812.94, low: 106800.01, close: 107329.61 },
  { date: '2025-05-24', open: 107332.08, high: 109517.79, low: 106895.77, close: 107794.01 },
  { date: '2025-05-25', open: 107794.01, high: 109371.04, low: 106632.35, close: 109048.68 },
  { date: '2025-05-26', open: 109048.41, high: 110474.41, low: 108706.04, close: 109464.32 },
  { date: '2025-05-27', open: 109464.33, high: 110829.42, low: 107536.41, close: 108978.46 },
  { date: '2025-05-28', open: 108978.45, high: 109344.89, low: 106790.16, close: 107819.29 },
  { date: '2025-05-29', open: 107819.26, high: 108943.35, low: 105315, close: 105572.58 },
  { date: '2025-05-30', open: 105572.58, high: 106377.66, low: 103634.48, close: 104033.26 },
  { date: '2025-05-31', open: 104033, high: 104965.5, low: 103110.01, close: 104645.87 },
  { date: '2025-06-01', open: 104645.87, high: 105937.46, low: 103800.81, close: 105697.94 },
  { date: '2025-06-02', open: 105697.93, high: 106000, low: 103685.23, close: 105904.94 },
  { date: '2025-06-03', open: 105909.79, high: 106901.68, low: 104910.01, close: 105447.82 },
  { date: '2025-06-04', open: 105443.95, high: 106058.47, low: 104202, close: 104753.38 },
  { date: '2025-06-05', open: 104753.37, high: 105999.68, low: 100345.73, close: 101570.2 },
  { date: '2025-06-06', open: 101570.2, high: 105439.01, low: 101132.91, close: 104397.99 },
  { date: '2025-06-07', open: 104398, high: 106000, low: 103969.7, close: 105619.02 },
  { date: '2025-06-08', open: 105619.02, high: 106548.9, low: 105028.3, close: 105784.4 },
  { date: '2025-06-09', open: 105784.41, high: 110651.12, low: 105368.27, close: 110301.15 },
  { date: '2025-06-10', open: 110299.69, high: 110420.08, low: 108362.14, close: 110300.24 },
  { date: '2025-06-11', open: 110300.25, high: 110435.05, low: 108091.74, close: 108669.37 },
  { date: '2025-06-12', open: 108673.77, high: 108853.74, low: 105706.78, close: 105721.05 },
  { date: '2025-06-13', open: 105716.45, high: 106233, low: 102746.01, close: 106118.7 },
  { date: '2025-06-14', open: 106114.53, high: 106264.36, low: 104351.72, close: 105465.42 },
  { date: '2025-06-15', open: 105465.42, high: 106184.13, low: 104505.05, close: 105599.25 },
  { date: '2025-06-16', open: 105600.21, high: 109000, low: 104982.26, close: 106853.38 },
  { date: '2025-06-17', open: 106853.38, high: 107792.9, low: 103363.3, close: 104590.44 },
  { date: '2025-06-18', open: 104590.44, high: 105603.63, low: 103512.38, close: 104915.6 },
  { date: '2025-06-19', open: 104915.6, high: 105266.61, low: 103916.37, close: 104671.9 },
  { date: '2025-06-20', open: 104671.4, high: 106553.86, low: 102357.25, close: 103317.8 },
  { date: '2025-06-21', open: 103317.79, high: 104013.64, low: 100919.19, close: 102160.03 },
  { date: '2025-06-22', open: 102160.36, high: 103417, low: 98225.01, close: 100996.87 },
  { date: '2025-06-23', open: 100996.87, high: 106135.47, low: 99677.07, close: 105419.39 },
  { date: '2025-06-24', open: 105418.4, high: 106366.29, low: 104681.83, close: 106141 },
  { date: '2025-06-25', open: 106141.01, high: 108206, low: 105875, close: 107400.22 },
  { date: '2025-06-26', open: 107400.22, high: 108345, low: 106605.88, close: 107029.64 },
  { date: '2025-06-27', open: 107029.63, high: 107804.2, low: 106413.79, close: 107113.38 },
  { date: '2025-06-28', open: 107352.2, high: 108550, low: 106868.94, close: 108386.44 },
  { date: '2025-06-29', open: 108386.44, high: 108800, low: 107230, close: 107173.21 },
  { date: '2025-06-30', open: 107173.21, high: 107579.3, low: 106724.76, close: 107352.2 },
  { date: '2025-07-01', open: 107173.21, high: 107579.3, low: 105262, close: 105711.78 },
  { date: '2025-07-02', open: 105711.77, high: 109823.08, low: 105119.7, close: 108888.32 },
  { date: '2025-07-03', open: 108887.03, high: 110590, low: 108574.31, close: 109628.83 },
  { date: '2025-07-04', open: 109628.83, high: 109812.94, low: 107268.84, close: 108028.6 },
];

describe('computeTrendlines', () => {
  it('detects an active support line in an orderly uptrend', () => {
    const { trendlines } = computeTrendlines(buildMarketData(), { swingLookback: 2 });
    const supportLines = findSupportLines(trendlines);

    expect(supportLines.length).toBeGreaterThan(0);
    expect(supportLines.some((line) => line.isActive)).toBe(true);
  });

  it('honours the configured price source for slope calculations', () => {
    const data = buildMarketData();
    const { trendlines } = computeTrendlines(data, {
      swingLookback: 2,
      supportSlopePriceSource: 'close',
    });
    const [chosen] = findSupportLines(trendlines);

    expect(chosen).toBeDefined();
    expect(chosen?.meta.priceSource).toBe('close');
    if (chosen) {
      expect(chosen.start.price).toBe(data[chosen.start.index].c);
    }
  });

  it('detects downward-sloping resistance lines', () => {
    const { trendlines } = computeTrendlines(buildResistanceData(), { swingLookback: 1 });
    const resistanceLines = findResistanceLines(trendlines);

    expect(resistanceLines.length).toBeGreaterThan(0);
    const activeResistance = resistanceLines.find((line) => line.isActive);
    expect(activeResistance).toBeDefined();
    expect((activeResistance?.slope ?? 0) < 0).toBe(true);
  });

  it('reduces the number of lines as the swing lookback increases', () => {
    const base = buildMarketData();
    const { trendlines: defaultLines } = computeTrendlines(base, { swingLookback: 2 });
    const { trendlines: stricterLines } = computeTrendlines(base, { swingLookback: 8 });

    expect(stricterLines.length).toBeLessThanOrEqual(defaultLines.length);
  });

  it('allows a new resistance line to start where the previous one ended', () => {
    const highs = [100, 110, 90, 105, 85, 95, 80];
    const candles: Candle[] = highs.map((high, index) => ({
      t: index,
      o: high - 2,
      h: high,
      l: high - 6,
      c: high - 3,
    }));

    const { trendlines } = computeTrendlines(candles, {
      swingLookback: 1,
      minSegmentLength: 1,
      minSlopePctPerCandle: 0.0001,
      minSlopeDeltaPct: 10,
      allowAnchorDrift: false,
    });

    const resistanceLines = trendlines.filter((line) => line.type === 'resistance');

    expect(resistanceLines).toHaveLength(2);
    expect(resistanceLines[0].startIndex).toBe(1);
    expect(resistanceLines[1].startIndex).toBe(3);
  });

  it('extends v1 support lines through the first lower low and emits a breach close event', () => {
    const candles = buildCandlesFromRaw(btcUsdSlice);
    const params = { swingLookback: 2 as const };
    const endDate = '2025-06-22T00:00:00.000Z';

    const { trendlines } = computeTrendlinesV1(candles, params);
    const supportLines = trendlines.filter((line) => line.type === 'support');
    const targetLine = supportLines.find((line) => line.end.date === endDate);

    expect(targetLine).toBeDefined();
    expect(targetLine?.isActive).toBe(false);

    const events = detectEventsV1(candles, params);
    const closeEvents = events.filter(
      (event) =>
        event.payload?.variant === 'close' &&
        event.payload.lineType === 'support',
    );

    expect(closeEvents.length).toBeGreaterThan(0);

    closeEvents.forEach((event) => {
    const payload = event.payload as TrendlineBreachEventPayload | undefined;
    if (!payload) {
      return;
    }
    const index = payload.detail.index;
    const prevIndex = index - 1;
    if (prevIndex < 0 || !candles[prevIndex]) {
      return;
    }
    const linePrice = payload.detail.linePrice;
    const slope = payload.slope;
    const startIndex = payload.startIndex;
    const startPrice = linePrice - slope * (index - startIndex);
    const prevLinePrice = startPrice + slope * (prevIndex - startIndex);
    const prevClose = candles[prevIndex].c;
    const currClose = candles[index].c;
    const prevDiff = prevClose - prevLinePrice;
    const currDiff = currClose - linePrice;

    const crossed =
      (prevDiff <= 0 && currDiff > 0) || (prevDiff >= 0 && currDiff < 0);
    expect(crossed).toBe(true);
  });
  });
});

describe('trendline events', () => {
  it('exposes metadata and emits breach events', () => {
    const definitions = getEventDefinitions();
    expect(definitions.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        'trendline_breach_bullish',
        'trendline_breach_bearish',
        'trendline_break_bullish',
        'trendline_break_bearish',
      ]),
    );

    const brokenEvents = detectEvents(buildMarketData({ withBreak: true }), { swingLookback: 2 });
    expect(brokenEvents.some((event) => event.id === 'trendline_breach_bearish')).toBe(true);

    const untouchedEvents = detectEvents(buildMarketData({ withBreak: false }), { swingLookback: 2 });
    expect(untouchedEvents.some((event) => event.id.startsWith('trendline_breach'))).toBe(false);
  });
});

describe('slope direction guards', () => {
  it('allows bullish breaks only for downward resistance lines', () => {
    expect(isSlopeDirectionCompatible(-0.01, 'resistance_break')).toBe(true);
    expect(isSlopeDirectionCompatible(0.01, 'resistance_break')).toBe(false);
    expect(isSlopeDirectionCompatible(0, 'resistance_break')).toBe(false);
  });

  it('allows bearish breaks only for upward support lines', () => {
    expect(isSlopeDirectionCompatible(0.02, 'support_break')).toBe(true);
    expect(isSlopeDirectionCompatible(-0.02, 'support_break')).toBe(false);
    expect(isSlopeDirectionCompatible(0, 'support_break')).toBe(false);
  });
});
