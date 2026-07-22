#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
html_dir="$project_root/sources/site_html"
base="https://jyywiki.cn/OS"

mkdir -p "$html_dir"

fetch() {
  local url=$1
  local destination=$2
  curl -L -sS --fail --retry 3 "$url" -o "$destination"
}

fetch "$base/2026/" "$html_dir/index.html"
fetch "$base/Overview_new.md" "$html_dir/overview.html"
fetch "$base/References_new.md" "$html_dir/references.html"

for number in $(seq 1 30); do
  printf -v padded "%02d" "$number"
  fetch "$base/2026/lect${number}.md" "$html_dir/lect${padded}.html"
done

fetch "$base/2026/labs/Labs.md" "$html_dir/labs.html"
for number in $(seq 1 9); do
  fetch "$base/2026/labs/M${number}.md" "$html_dir/M${number}.html"
done

while IFS= read -r reference; do
  asset=${reference#src=\"}
  asset=${asset%\"}
  mkdir -p "$(dirname "$html_dir/$asset")"
  fetch "$base/2026/$asset" "$html_dir/$asset"
done < <(
  rg -o --no-filename 'src="static/img/[^"]+"' "$html_dir"/*.html | sort -u
)

lab_img_dir="$project_root/sources/img"
mkdir -p "$lab_img_dir"
while IFS= read -r reference; do
  asset=${reference#src=\"../../img/}
  asset=${asset%\"}
  fetch "$base/img/$asset" "$lab_img_dir/$asset"
done < <(
  rg -o --no-filename 'src="\.\./\.\./img/[^"]+"' "$html_dir"/*.html | sort -u
)

mkdir -p "$project_root/sources/notes/img" "$project_root/sources/manuals"
fetch "$base/ostep-fun.jpg" "$project_root/sources/notes/ostep-fun.jpg"
fetch "$base/csapp-fun.jpg" "$project_root/sources/notes/csapp-fun.jpg"
fetch "$base/img/eager-for-power.jpg" \
  "$project_root/sources/notes/img/eager-for-power.jpg"
fetch "$base/manuals/bitter_lesson.pdf" \
  "$project_root/sources/manuals/bitter_lesson.pdf"
fetch "$base/manuals/MSFAT-spec.pdf" \
  "$project_root/sources/manuals/MSFAT-spec.pdf"

python "$project_root/scripts/extract_notes.py"
