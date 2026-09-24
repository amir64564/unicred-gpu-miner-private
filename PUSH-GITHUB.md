# Push to private GitHub (amir64564/unicred-gpu-miner-private)

gh CLI on this box is **not logged in**, and the GitHub MCP has no create_repository tool.
Create + push from a machine where you are logged in as amir64564:

```bash
# one-time
gh auth login   # as amir64564

cd unicred-miner   # or extract unicred-miner.tar.gz
gh repo create amir64564/unicred-gpu-miner-private --private --source=. --remote=origin --push
```

Or:
```bash
gh repo create unicred-gpu-miner-private --private
git remote add origin git@github.com:amir64564/unicred-gpu-miner-private.git
git push -u origin master
```

Never commit `.env` (already gitignored).
