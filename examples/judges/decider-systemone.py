#!/usr/bin/env python3
"""Read one System One request on stdin and write its Decider answer to stdout."""
import argparse
import json
import sys
from decider.infer import Decider

parser = argparse.ArgumentParser()
parser.add_argument('--repo', required=True)
parser.add_argument('--gguf-file')
parser.add_argument('--threads', type=int)
args = parser.parse_args()
options = {'n_ctx': 8192, 'n_gpu_layers': 0}
if args.threads:
    options['n_threads'] = args.threads
model = Decider(args.repo, gguf_file=args.gguf_file, gguf_options=options) if args.gguf_file else Decider(args.repo)
request = json.load(sys.stdin)
json.dump(model.system_one(request['state'], request['questions']), sys.stdout)
