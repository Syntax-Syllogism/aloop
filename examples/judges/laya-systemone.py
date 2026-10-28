#!/usr/bin/env python3
"""Read one System One request and answer it with a local Laya checkpoint."""
import argparse
import json
import sys

import laya

parser = argparse.ArgumentParser()
parser.add_argument('--repo', default='convaiinnovations/laya-typed-decisions')
args = parser.parse_args()

request = json.load(sys.stdin)
model = laya.load(args.repo)
json.dump(model.predict(request['state'], request['questions']), sys.stdout)
