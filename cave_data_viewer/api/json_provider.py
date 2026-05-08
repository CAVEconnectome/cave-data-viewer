import math

import numpy as np
import pandas as pd
from flask.json.provider import DefaultJSONProvider


class NumpyJSONProvider(DefaultJSONProvider):
    def default(self, o):
        # `pd.NA` is the singleton missing-value for pandas nullable dtypes
        # (Int64, string, boolean…). Distinct from np.nan, distinct from None,
        # and not handled by JSON's default encoder. Coerce to null.
        if o is pd.NA:
            return None
        if isinstance(o, np.integer):
            return int(o)
        if isinstance(o, np.floating):
            value = float(o)
            return value if math.isfinite(value) else None
        if isinstance(o, np.bool_):
            return bool(o)
        if isinstance(o, np.ndarray):
            return o.tolist()
        if hasattr(o, "isoformat"):
            return o.isoformat()
        return super().default(o)
