# 1. Overview
This project develops a spatial-statistical framework to model the probability of icy surface conditions in Helsinki. ERA5 data was obtained through Google Earth Engine. The study aims to estimate where and when icy surface conditions are likely to occur across Helsinki using a grid-based dataset. The workflow combines physical reasoning and spatial statistics:

1. Construct a proxy icy-condition indicator from thermal and moisture conditions.
2. Fit a baseline binary logistic model.
3. Test whether the observed icy pattern is spatially autocorrelated.
4. Map local clusters and spatial lag structure.
5. Explore nonlinear effects with GAM smoothers.
6. Diagnose remaining spatial dependence with CAR.
7. Decompose structured and unstructured residual variation with ICAR and BYM.
8. Extend the logistic model with spatial effects.

# 2. Data and preprocessing
The study period is from December 2024 to March 2025, and the geometry is based on a 500 m grid. The original data was extracted from ERA5 dataset. The variables include snow cover, temperature, dew point, wind, precipitation, snowfall, freezing degree hours, land cover fractions, distance to water, and elevation.

### Table 1. Selected descriptive statistics for key predictors

| variable              |     mean |      std |     min |     50% |      max |
|:----------------------|---------:|---------:|--------:|--------:|---------:|
| snow_frac             |    0.563 |    0.488 |   0.000 |   1.000 |    1.000 |
| t2m_mean_c            |   -0.818 |    3.524 | -10.359 |  -0.162 |    7.768 |
| precip_sum_mm         |    1.584 |    2.415 |   0.000 |   0.651 |   16.812 |
| freezing_degree_hours |   47.269 |   59.126 |   0.000 |  22.105 |  248.619 |
| built_frac            |    0.068 |    0.159 |   0.000 |   0.000 |    1.000 |
| water_frac            |    0.875 |    0.305 |   0.000 |   1.000 |    1.000 |
| dist_to_water_mean_m  | 1951.455 | 2307.942 |   0.000 | 439.488 | 5000.000 |
| elevation_mean_m      |   25.250 |   28.328 |  -1.000 |  14.154 |  123.255 |

These summaries show a winter dataset centered near freezing conditions. The median daily mean temperature is close to 0°C, median snow fraction is 1.0, and freezing degree hours are often substantial.

# 3. Construction of the icy-condition indicator
Because direct observations of road or surface ice were not available, this study constructs a proxy probability of icy conditions. The binary target is denoted by:

$$
P_{ice,i} = \Pr(Y_i = 1)
$$

where $Y_i$ is the indicator of icy conditions for location $i$.

The physical assumption is that ice requires both favorable thermal conditions and surface moisture. The two parts are combined as:

$$
P_{ice,i} = P_{thermal,i} \times P_{moisture,i}
$$

A location cannot have high ice probability if it is thermally unsuitable, and it also cannot have high ice probability if there is no moisture source.
## 3.1 Thermal condition

The thermal part of the model contains three components.

### (a) Temperature proximity to freezing

$$
P_{temp,i} = \exp\left(-\frac{T_i^2}{2\sigma_T^2}\right)
$$

Here, $T_i$ is the daily mean temperature. The parameter $\sigma_T$ controls how quickly the function decays as temperature moves away from 0°C. This term is largest near the freezing point, which is physically reasonable because ice formation is often most likely close to 0°C.

### (b) Freeze–thaw transition

$$
P_{ft,i} = \beta_{ft} \cdot I(CZ > 0)
$$

where $I(CZ > 0)$ is an indicator that temperature crossed 0°C, and $\beta_{ft}$ is a fixed boost. This term reflects the idea that crossing the freezing point creates melt–refreeze conditions, which are especially favorable for slippery surfaces.

### (c) Freezing degree hours

$$
P_{fdh,i} = 1 - \exp(-\lambda_{fdh} FDH_i)
$$

where $FDH_i$ is freezing degree hours. This is a saturating curve. Short freezing exposure raises risk quickly, while very long exposure does not increase the probability indefinitely.

The three thermal components are combined as:

$$
P_{thermal,i} = w_{temp} P_{temp,i} + w_{ft} P_{ft,i} + w_{fdh} P_{fdh,i}
$$

The result is then clipped to the interval $[0,1]$.
