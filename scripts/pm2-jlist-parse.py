import json
import sys
d = json.load(open(sys.argv[1], encoding='utf-8'))
for p in d:
    env = p.get('pm2_env', {}) or {}
    print(p.get('name'), '|pid=', p.get('pid'), '|status=', env.get('status'), '|out=', env.get('pm_out_log_path'), '|cwd=', env.get('pm_cwd'))
