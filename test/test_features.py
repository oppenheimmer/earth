"""Wind/ocean conversion features and native dependency checks; no live services."""
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import numpy as np
import pygrib
import xarray as xr
import copernicusmarine
import refresh_wind as wind
import refresh_waves as waves
import refresh_ocean as ocean
from datasets import validate

SAMPLE = (ROOT / 'test/fixtures/regular_ll_sfc_grib2.tmpl').read_bytes()


def message(short_name, value, level=None):
    grb = pygrib.fromstring(SAMPLE)
    for key, val in {
        'Ni': 4, 'Nj': 3,
        'latitudeOfFirstGridPointInDegrees': 90,
        'latitudeOfLastGridPointInDegrees': -90,
        'longitudeOfFirstGridPointInDegrees': 0,
        'longitudeOfLastGridPointInDegrees': 270,
        'iDirectionIncrementInDegrees': 90,
        'jDirectionIncrementInDegrees': 90,
        'dataDate': 20261028, 'dataTime': 0,
    }.items():
        grb[key] = val
    if level is not None:
        grb['typeOfLevel'] = 'isobaricInhPa'
        grb['level'] = level
    grb['shortName'] = short_name
    grb['values'] = np.full((3, 4), value, dtype=float)
    return grb.tostring()


class NativeDependencies(unittest.TestCase):
    def test_numpy_and_coordinate_transforms(self):
        from pyproj import Transformer
        values = np.ma.array([1., 2., 3.], mask=[False, True, False])
        np.testing.assert_equal(values.filled(np.nan), [1., np.nan, 3.])
        forward = Transformer.from_crs(4326, 3857, always_xy=True)
        inverse = Transformer.from_crs(3857, 4326, always_xy=True)
        np.testing.assert_allclose(inverse.transform(*forward.transform(139.7, 35.7)), [139.7, 35.7])

    def test_hdf5_netcdf_roundtrip(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'ocean.nc'
            data = xr.Dataset({'uo': (('latitude', 'longitude'), np.arange(12.).reshape(3, 4))})
            data.to_netcdf(path, engine='h5netcdf')
            with xr.open_dataset(path, engine='h5netcdf') as loaded:
                xr.testing.assert_equal(loaded.load(), data)

    def test_zarr_and_dask_roundtrip(self):
        import dask.array as da
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'ocean.zarr'
            data = xr.Dataset({'uo': (('latitude', 'longitude'), da.arange(12., chunks=4).reshape(3, 4))})
            data.to_zarr(path, zarr_format=2)
            with xr.open_zarr(path) as loaded:
                xr.testing.assert_equal(loaded.compute(), data.compute())

    def test_parquet_roundtrip(self):
        import pyarrow as pa
        import pyarrow.parquet as pq
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'catalog.parquet'
            table = pa.table({'product': ['currents', 'temperature'], 'depth': [.494, .494]})
            pq.write_table(table, path)
            self.assertTrue(pq.read_table(path).equals(table))


def atmosphere_case(name, product):
    def check(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            input_file = directory / 'input.grib2'
            select = product['select']
            if name in wind.LEVELS:
                u = select['shortName']
                content = message(u, 3., select.get('level')) + message(u.replace('u', 'v'), 4., select.get('level'))
                expected = [3., 4.]
            else:
                content = message(select['shortName'], 280. if name != 'rh' else 60.)
                expected = [280. if name != 'rh' else 60.]
            input_file.write_bytes(content)
            with patch.object(wind, 'DATA_DIR', str(directory)), patch.object(sys, 'argv', [wind.__file__, name, str(input_file)]):
                wind.main()
            output = json.loads((directory / product['out']).read_text())
            validate(output)
            self.assertEqual(len(output), len(expected))
            for record, value in zip(output, expected):
                np.testing.assert_allclose(record['data'], [value] * 12)
                self.assertEqual(record['header']['refTime'][:10], '2026-10-28')
            self.assertEqual(input_file.read_bytes(), content)
    return check


class ConverterFeature(unittest.TestCase):
    def setUp(self):
        self.enterContext(contextlib.redirect_stdout(io.StringIO()))


class WindDisplays(ConverterFeature):
    pass


class OceanDisplays(ConverterFeature):
    def test_wave_motion_and_height(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            input_file = directory / 'waves.grib2'
            input_file.write_bytes(message('swh', 2.) + message('perpw', 10.) + message('dirpw', 270.))
            with patch.object(waves, 'DATA_DIR', str(directory)), patch.object(sys, 'argv', [waves.__file__, str(input_file)]):
                waves.main()
            flow = json.loads((directory / waves.FLOW_OUT).read_text())
            height = json.loads((directory / waves.HEIGHT_OUT).read_text())
            validate(flow)
            validate(height)
            np.testing.assert_allclose(flow[0]['data'], [10.] * 12)
            np.testing.assert_allclose(flow[1]['data'], [0.] * 12, atol=.001)
            np.testing.assert_allclose(height[0]['data'], [2.] * 12)


def ocean_case(name, product):
    def check(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            depth = sum(product['depth']) / 2
            fields = {}
            for index, variable in enumerate(product['variables']):
                values = np.full((1, 1, 7, 12), index + 3., dtype=float)
                values[0, 0, 3, 3] = np.nan
                fields[variable] = (('time', 'depth', 'latitude', 'longitude'), values)
            data = xr.Dataset(fields, coords={
                'time': [np.datetime64('2026-10-28')], 'depth': [depth],
                'latitude': np.linspace(-90, 90, 7), 'longitude': np.arange(12) * 30.,
            })
            source = directory / 'source.nc'
            data.to_netcdf(source, engine='h5netcdf')
            opened = []
            def open_local(**kwargs):
                self.assertEqual(kwargs['dataset_id'], product['dataset_id'])
                self.assertEqual(kwargs['variables'], product['variables'])
                ds = xr.open_dataset(source, engine='h5netcdf')
                opened.append(ds)
                return ds
            try:
                with patch.object(copernicusmarine, 'open_dataset', side_effect=open_local), patch.object(ocean, 'DATA_DIR', str(directory)):
                    ocean.refresh_product(name, product, np.datetime64('2026-10-28'), 1, 1)
                output = json.loads((directory / product['out']).read_text())
                validate(output)
                self.assertEqual(len(output), len(product['variables']))
                for index, record in enumerate(output):
                    self.assertEqual((record['header']['nx'], record['header']['ny']), (4, 3))
                    self.assertEqual(record['header']['surface1Value'], round(depth, 3))
                    np.testing.assert_allclose(record['data'], [index + 3.] * 12)
            finally:
                for ds in opened:
                    ds.close()
    return check


for name, product in (wind.LEVELS | wind.SCALARS).items():
    setattr(WindDisplays, 'test_' + name, atmosphere_case(name, product))
for name, product in ocean.PRODUCTS.items():
    setattr(OceanDisplays, 'test_' + name, ocean_case(name, product))

if __name__ == '__main__':
    unittest.main()
