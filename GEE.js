// Setting

var aoi = ee.Geometry.Rectangle([24.5, 59.9, 25.4, 60.5], null, false);

var startDate = ee.Date('2024-12-01');
var endDate   = ee.Date('2025-03-31');

var exportStart = '2025-01-01';
var exportEnd   = '2025-01-31';

var gridSize = 500;

var proj3067 = ee.Projection('EPSG:3067');

// Snow threshold for MODIS NDSI snow cover (%)
var snowThreshold = 20;

// Distance cap for predictor stability (m)
var distanceCap = 5000;

var era5Scale = 11132;


// Map Setup

Map.centerObject(aoi, 9);
Map.addLayer(aoi, {color: 'red'}, 'AOI');


// Creating 500 m grid

var rawGrid = aoi.coveringGrid(proj3067.atScale(gridSize));

var gridList = rawGrid.toList(rawGrid.size());
var idList = ee.List.sequence(0, rawGrid.size().subtract(1));

var grid = ee.FeatureCollection(
  idList.map(function(i) {
    i = ee.Number(i);
    var f = ee.Feature(gridList.get(i));
    var centroid = f.geometry().centroid({'maxError': 1, 'proj': proj3067});
    var coords = centroid.coordinates();

    return f.set({
      'grid_id': i.format('%06d'),
      'x': coords.get(0),
      'y': coords.get(1)
    });
  })
);


Map.addLayer(
  grid.style({color: 'gray', fillColor: '00000000', width: 1}),
  {},
  'Grid',
  false
);


// Masking Waster

// Water / coast

var waterOccurrence = ee.Image('JRC/GSW1_4/GlobalSurfaceWater')
  .select('occurrence')
  .clip(aoi);

var waterBinary = waterOccurrence.gte(50).rename('water_binary');
var waterMask = waterBinary.selfMask().rename('water_mask');

var distanceToWater = waterMask
  .fastDistanceTransform(30)
  .sqrt()
  .multiply(30)
  .rename('dist_to_water_m')
  .clip(aoi)
  .min(ee.Image.constant(distanceCap))
  .rename('dist_to_water_m');

Map.addLayer(
  distanceToWater,
  {min: 0, max: distanceCap},
  'Distance to water (m)',
  false
);

// DEM / terrain

var dem = ee.ImageCollection('COPERNICUS/DEM/GLO30')
  .select('DEM')
  .mosaic()
  .clip(aoi)
  .rename('elevation_m');

var terrain = ee.Terrain.products(dem);
var slope = terrain.select('slope').rename('slope_deg');

Map.addLayer(dem, {min: 0, max: 100}, 'Elevation', false);
Map.addLayer(slope, {min: 0, max: 20}, 'Slope', false);

// Land cover

var worldcover = ee.ImageCollection('ESA/WorldCover/v200')
  .first()
  .select('Map')
  .clip(aoi);

var builtMask = worldcover.eq(50).rename('built');
var treeMask  = worldcover.eq(10).rename('tree');
var vegMask   = worldcover.eq(10)
  .or(worldcover.eq(20))
  .or(worldcover.eq(30))
  .or(worldcover.eq(40))
  .or(worldcover.eq(90))
  .or(worldcover.eq(100))
  .rename('vegetation');

Map.addLayer(worldcover, {}, 'WorldCover', false);


// Convert ERA5 data to the 500m grid

function addStaticPredictors(feature) {
  feature = ee.Feature(feature);
  var geom = feature.geometry();

  var meanElevation = dem.reduceRegion({
    reducer: ee.Reducer.mean(),
    geometry: geom,
    scale: 30,
    maxPixels: 1e9
  }).get('elevation_m');

  var meanSlope = slope.reduceRegion({
    reducer: ee.Reducer.mean(),
    geometry: geom,
    scale: 30,
    maxPixels: 1e9
  }).get('slope_deg');

  var meanDistWater = distanceToWater.reduceRegion({
    reducer: ee.Reducer.mean(),
    geometry: geom,
    scale: 30,
    maxPixels: 1e9
  }).get('dist_to_water_m');

  var builtFrac = builtMask.reduceRegion({
    reducer: ee.Reducer.mean(),
    geometry: geom,
    scale: 10,
    maxPixels: 1e9
  }).get('built');

  var treeFrac = treeMask.reduceRegion({
    reducer: ee.Reducer.mean(),
    geometry: geom,
    scale: 10,
    maxPixels: 1e9
  }).get('tree');

  var vegFrac = vegMask.reduceRegion({
    reducer: ee.Reducer.mean(),
    geometry: geom,
    scale: 10,
    maxPixels: 1e9
  }).get('vegetation');

  var waterFrac = waterBinary.reduceRegion({
    reducer: ee.Reducer.mean(),
    geometry: geom,
    scale: 30,
    maxPixels: 1e9
  }).get('water_binary');

  return feature.set({
    'elevation_mean_m': meanElevation,
    'slope_mean_deg': meanSlope,
    'dist_to_water_mean_m': meanDistWater,
    'built_frac': builtFrac,
    'tree_frac': treeFrac,
    'vegetation_frac': vegFrac,
    'water_frac': waterFrac
  });
}

var gridStatic = grid.map(addStaticPredictors);

// Snow from MODIS

var modisSnow = ee.ImageCollection('MODIS/061/MOD10A1')
  .filterDate(startDate, endDate.advance(1, 'day'))
  .select('NDSI_Snow_Cover');

function getDailySnowImage(date) {
  date = ee.Date(date);

  var img = modisSnow.filterDate(date, date.advance(1, 'day')).first();
  img = ee.Image(ee.Algorithms.If(
    img,
    img,
    ee.Image.constant(-999).rename('NDSI_Snow_Cover')
  ));

  var snowBinary = img.gte(snowThreshold).rename('snow_binary');

  return ee.Image.cat([
    img.rename('snow_ndsi'),
    snowBinary
  ]).set('date', date.format('YYYY-MM-dd'));
}


//  Extracting ERA5 Data

var era5 = ee.ImageCollection('ECMWF/ERA5_LAND/HOURLY')
  .filterDate(startDate, endDate.advance(1, 'day'))
  .filterBounds(aoi)
  .select([
    'temperature_2m',
    'dewpoint_temperature_2m',
    'total_precipitation_hourly',
    'snowfall_hourly',
    'u_component_of_wind_10m',
    'v_component_of_wind_10m'
  ]);

function dailyEra5Image(date) {
  date = ee.Date(date);
  var daily = era5.filterDate(date, date.advance(1, 'day'));

  var hasData = daily.size().gt(0);

  var out = ee.Image(ee.Algorithms.If(hasData, (function() {

    var tMean = daily.select('temperature_2m').mean()
      .subtract(273.15).rename('t2m_mean_c');

    var tMin = daily.select('temperature_2m').min()
      .subtract(273.15).rename('t2m_min_c');

    var tMax = daily.select('temperature_2m').max()
      .subtract(273.15).rename('t2m_max_c');

    var tdMean = daily.select('dewpoint_temperature_2m').mean()
      .subtract(273.15).rename('d2m_mean_c');

    var dewDep = tMean.subtract(tdMean).rename('dewpoint_depression_c');

    var windHourly = daily.map(function(img) {
      var u = img.select('u_component_of_wind_10m');
      var v = img.select('v_component_of_wind_10m');
      var ws = u.pow(2).add(v.pow(2)).sqrt().rename('wind10m');
      return ws.copyProperties(img, img.propertyNames());
    });

    var windMean = windHourly.mean().rename('wind10m_mean_ms');

    var precipSum = daily.select('total_precipitation_hourly').sum()
      .multiply(1000)
      .rename('precip_sum_mm');

    var snowfallSum = daily.select('snowfall_hourly').sum()
      .multiply(1000)
      .rename('snowfall_sum_mm');

    var snowfallFrac = snowfallSum.divide(precipSum.max(0.1))
      .min(1)
      .rename('snowfall_frac');

    var snowfallOccurred = snowfallSum.gt(0.1)
      .rename('snowfall_occurred');

    var freezingHoursCol = daily.map(function(img) {
      var tc = img.select('temperature_2m').subtract(273.15);
      var fdh = tc.lt(0).multiply(tc.abs()).rename('fdh');
      return fdh.copyProperties(img, img.propertyNames());
    });

    var freezingDegreeHours = freezingHoursCol.sum()
      .rename('freezing_degree_hours');

    var freezeThawCol = daily.map(function(img) {
      var tc = img.select('temperature_2m').subtract(273.15);
      var indicator = tc.gte(-1).and(tc.lte(1)).rename('freeze_thaw_hour');
      return indicator.copyProperties(img, img.propertyNames());
    });

    var freezeThawHours = freezeThawCol.sum()
      .rename('freeze_thaw_hours');

    var crossesZero = tMin.lt(0).and(tMax.gt(0)).rename('crosses_zero');

    return ee.Image.cat([
      tMean,
      tMin,
      tMax,
      tdMean,
      dewDep,
      windMean,
      precipSum,
      snowfallSum,
      snowfallFrac,
      snowfallOccurred,
      freezingDegreeHours,
      freezeThawHours,
      crossesZero
    ])
    .clip(aoi)
    .resample('bilinear')
    .reproject({
      crs: proj3067,
      scale: gridSize
    });

  })(), 
  ee.Image.constant([
    -9999,  // t2m_mean_c
    -9999,  // t2m_min_c
    -9999,  // t2m_max_c
    -9999,  // d2m_mean_c
    -9999,  // dewpoint_depression_c
    -9999,  // wind10m_mean_ms
    0,      // precip_sum_mm
    0,      // snowfall_sum_mm
    0,      // snowfall_frac
    0,      // snowfall_occurred
    0,      // freezing_degree_hours
    0,      // freeze_thaw_hours
    0       // crosses_zero
  ]).rename([
    't2m_mean_c',
    't2m_min_c',
    't2m_max_c',
    'd2m_mean_c',
    'dewpoint_depression_c',
    'wind10m_mean_ms',
    'precip_sum_mm',
    'snowfall_sum_mm',
    'snowfall_frac',
    'snowfall_occurred',
    'freezing_degree_hours',
    'freeze_thaw_hours',
    'crosses_zero'
  ]).clip(aoi).reproject({
    crs: proj3067,
    scale: gridSize
  })));

  return out.set({
    'date': date.format('YYYY-MM-dd'),
    'era5_has_data': hasData
  });
}


// Dates

var nDays = endDate.difference(startDate, 'day').add(1);
var dateList = ee.List.sequence(0, nDays.subtract(1)).map(function(d) {
  return startDate.advance(ee.Number(d), 'day');
});


// Building the tables for download

function summarizeDay(date) {
  date = ee.Date(date);
  var dateString = date.format('YYYY-MM-dd');

  var snowImg = getDailySnowImage(date).clip(aoi);
  var metImg  = dailyEra5Image(date);

  var dailyFeatures = gridStatic.map(function(f) {
    f = ee.Feature(f);
    var geom = f.geometry();
    var centroid = geom.centroid({'maxError': 1, 'proj': proj3067});

    // Snow: polygon mean is appropriate
    var snowStats = snowImg.select([
      'snow_ndsi',
      'snow_binary'
    ]).reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: geom,
      scale: 500,
      maxPixels: 1e9
    });

    // Meteorology: use centroid sampling
    var metStats = metImg.reduceRegion({
      reducer: ee.Reducer.first(),
      geometry: centroid,
      scale: gridSize,
      maxPixels: 1e9
    });

    return f.set({
      'date': dateString,

      // Snow
      'snow_ndsi_mean': snowStats.get('snow_ndsi'),
      'snow_frac': snowStats.get('snow_binary'),

      // Meteorology
      't2m_mean_c': metStats.get('t2m_mean_c'),
      't2m_min_c': metStats.get('t2m_min_c'),
      't2m_max_c': metStats.get('t2m_max_c'),
      'd2m_mean_c': metStats.get('d2m_mean_c'),
      'dewpoint_depression_c': metStats.get('dewpoint_depression_c'),
      'wind10m_mean_ms': metStats.get('wind10m_mean_ms'),
      'precip_sum_mm': metStats.get('precip_sum_mm'),
      'snowfall_sum_mm': metStats.get('snowfall_sum_mm'),
      'snowfall_frac': metStats.get('snowfall_frac'),
      'snowfall_occurred': metStats.get('snowfall_occurred'),
      'freezing_degree_hours': metStats.get('freezing_degree_hours'),
      'freeze_thaw_hours': metStats.get('freeze_thaw_hours'),
      'crosses_zero': metStats.get('crosses_zero')
    });
  });

  return dailyFeatures;
}

var dailyGridTable = ee.FeatureCollection(dateList.map(summarizeDay)).flatten();

// Exports

var exportColsDaily = [
  'grid_id', 'date',
  'snow_ndsi_mean', 'snow_frac',
  't2m_mean_c', 't2m_min_c', 't2m_max_c',
  'd2m_mean_c', 'dewpoint_depression_c',
  'wind10m_mean_ms',
  'precip_sum_mm', 'snowfall_sum_mm',
  'snowfall_frac', 'snowfall_occurred',
  'freezing_degree_hours', 'freeze_thaw_hours', 'crosses_zero'
];

function dayTableForExport(date) {
  date = ee.Date(date);
  var fc = summarizeDay(date);

  fc = fc.map(function(f) {
    f = ee.Feature(f);
    f = f.select(exportColsDaily);
    return ee.Feature(null, f.toDictionary(exportColsDaily));
  });

  return fc;
}

function twoDigits(n) {
  return (n < 10 ? '0' : '') + n;
}

// Export one month of daily CSVs

var start = new Date(exportStart);
var end = new Date(exportEnd);

var dateStrings = [];
for (var d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
  var yyyy = d.getFullYear();
  var mm = twoDigits(d.getMonth() + 1);
  var dd = twoDigits(d.getDate());
  dateStrings.push(yyyy + '-' + mm + '-' + dd);
}


// Create one export task per day
for (var i = 0; i < dateStrings.length; i++) {
  var ds = dateStrings[i];
  var dsLabel = ds.replace(/-/g, '_');

  Export.table.toDrive({
    collection: dayTableForExport(ee.Date(ds)),
    description: 'Helsinki_Icy_' + dsLabel,
    folder: 'GEE_exports',
    fileNamePrefix: 'Helsinki_Icy_' + dsLabel,
    fileFormat: 'CSV',
    selectors: exportColsDaily
  });
}

// Export grid geometry

Export.table.toDrive({
  collection: gridStatic,
  description: 'Helsinki_GridStatic_Geometry_500m',
  folder: 'GEE_exports',
  fileNamePrefix: 'Helsinki_GridStatic_Geometry_500m',
  fileFormat: 'GeoJSON'
});