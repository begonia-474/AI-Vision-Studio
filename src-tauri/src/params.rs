//! 参数解析与归一化纯函数（无 IO）。
//! 两个职责：LoRA 权重归一化（魔搭 loras 字段的网关规则，原前端 useStudio 实现下沉），
//! 以及 params_json → 重新编辑/重新生成的参数还原（与命令层写库时的快照构建对称）。
//! 前端经 typegen 生成的 STRUCTURED_PARAM_KEYS 常量复用同一份键表——旧版 commands.rs
//! 与 sessionStore.ts 各有一份且互相点名，改动易漂移（AGENTS 已点名），现收敛为一处。

use serde_json::Value;

use crate::models::{EditJumpDto, LoraEntryDto, Studio};

/// params_json 中已结构化消费的键（size/n/aspect_ratio/quality/duration/mode/...）。
/// 剩余键为魔搭自由参数（steps/guidance/seed/negative_prompt 等）原样透传。
/// 唯一事实源：commands::generate 写快照时跳过这些键、parse_history_params 还原时
/// 按这些键抽离结构化字段，typegen 生成前端常量（constants.ts）供 freeParams 消费。
pub const STRUCTURED_PARAM_KEYS: &[&str] = &[
    "size",
    "n",
    "aspect_ratio",
    "quality",
    "duration",
    "mode",
    "output_format",
    "optimize_prompt_mode",
    "background",
    "web_search",
    "layer_decomposition",
    "references",
    "loras",
];

/// LoRA 权重归一化（魔搭 loras 字段，实测网关规则）：
/// - 空 repo 行忽略；全空返回 None；
/// - 单 LoRA：dict {repo: weight} 权重透传（任意数值生效）；字符串形式不带权重，
///   调权重无效（网关按默认权重处理）→ 单 LoRA 也发 dict 保留用户权重。
///   权重非法/非正数取 1。
/// - 多 LoRA：权重和必须恰为 1.0（大于/小于整体被忽略），只认 2 位小数 →
///   提交时等比归一（w/sum）四舍五入到 2 位，最后一项补余数保证和恰为 1.00；
///   全 0/空权重：均分 1/n（末项补余数）。
pub fn normalize_loras(loras: &[LoraEntryDto]) -> Option<Value> {
    let clean: Vec<&LoraEntryDto> = loras.iter().filter(|l| !l.repo.trim().is_empty()).collect();
    if clean.is_empty() {
        return None;
    }
    let as_val = |v: f64| Value::from(v);
    if clean.len() == 1 {
        let w = clean[0].weight.trim().parse::<f64>().ok();
        let wv = match w {
            Some(w) if w > 0.0 => w,
            _ => 1.0,
        };
        return Some(Value::Object(
            [(clean[0].repo.trim().to_string(), as_val(wv))]
                .into_iter()
                .collect(),
        ));
    }
    let raw: Vec<f64> = clean
        .iter()
        .map(|l| {
            l.weight
                .trim()
                .parse::<f64>()
                .ok()
                .map(|w| w.max(0.0))
                .unwrap_or(0.0)
        })
        .collect();
    let round2 = |x: f64| (x * 100.0).round() / 100.0;
    let sum: f64 = raw.iter().sum();
    let last = clean.len() - 1;
    let mut normed: Vec<f64>;
    if sum <= 0.0 {
        let base = round2(1.0 / clean.len() as f64);
        normed = raw.iter().map(|_| base).collect();
        normed[last] = round2(1.0 - base * last as f64);
    } else {
        normed = raw.iter().map(|w| round2(w / sum)).collect();
        let head: f64 = normed[..last].iter().sum();
        normed[last] = round2(1.0 - head);
    }
    let obj = clean
        .iter()
        .zip(normed.iter())
        .map(|(l, w)| (l.repo.trim().to_string(), as_val(*w)))
        .collect();
    Some(Value::Object(obj))
}

/// params_json.loras（提交格式：字符串或 {repo: weight}）→ 弹层行（LoraEntryDto[]）。
/// 字符串（旧数据/单 LoRA 字符串形式）→ 单行 weight "1"；dict → 每项一行，权重转字符串。
pub fn parse_loras(raw: Option<&Value>) -> Option<Vec<LoraEntryDto>> {
    let raw = raw?;
    if let Some(s) = raw.as_str() {
        let repo = s.trim();
        return if repo.is_empty() {
            None
        } else {
            Some(vec![LoraEntryDto {
                repo: repo.to_string(),
                weight: "1".to_string(),
            }])
        };
    }
    if let Some(obj) = raw.as_object() {
        let entries: Vec<LoraEntryDto> = obj
            .iter()
            .filter(|(repo, _)| !repo.trim().is_empty())
            .map(|(repo, w)| {
                let weight = match w {
                    Value::Number(n) => n.to_string(),
                    Value::String(s) => s.clone(),
                    _ => "1".to_string(),
                };
                LoraEntryDto {
                    repo: repo.clone(),
                    weight,
                }
            })
            .collect();
        return if entries.is_empty() {
            None
        } else {
            Some(entries)
        };
    }
    None
}

/// params_json（魔搭自由参数快照）→ 重新编辑/重新生成的参数还原（EditJumpDto）。
/// 结构化字段从 params_json 抽取（缺失保持 None，调用方按当前表单值兜底）；
/// 剩余自由参数（string/number）进 params；loras 单独解析为条目列表。
/// 与 commands::generate 的 params_json 快照构建对称（同一份 STRUCTURED_PARAM_KEYS）。
pub fn parse_history_params(
    studio: &str,
    model: &str,
    prompt: &str,
    params_json: Option<&str>,
) -> EditJumpDto {
    let value: Value = params_json
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| Value::Object(Default::default()));
    let obj = value.as_object().cloned().unwrap_or_default();
    let get_str =
        |k: &str| -> Option<String> { obj.get(k).and_then(|v| v.as_str()).map(|s| s.to_string()) };
    let get_bool = |k: &str| -> Option<bool> { obj.get(k).and_then(|v| v.as_bool()) };

    let refs = obj
        .get("references")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
        })
        .filter(|r: &Vec<String>| !r.is_empty());

    // 自由参数：结构化键之外、值仅 string/number（与旧前端 jumpParams 语义一致）。
    let mut free = serde_json::Map::new();
    for (k, v) in &obj {
        if STRUCTURED_PARAM_KEYS.contains(&k.as_str()) {
            continue;
        }
        if v.is_string() || v.is_number() {
            free.insert(k.clone(), v.clone());
        }
    }
    let free = if free.is_empty() {
        None
    } else {
        Some(Value::Object(free))
    };

    EditJumpDto {
        studio: match studio {
            "video" => Studio::Video,
            _ => Studio::Image,
        },
        prompt: prompt.to_string(),
        model_id: Some(model.to_string()),
        ar: get_str("aspect_ratio"),
        quality: get_str("quality"),
        duration: get_str("duration"),
        n: obj.get("n").and_then(|v| v.as_i64()),
        mode: get_str("mode").filter(|m| m == "single" || m == "group"),
        format: get_str("output_format"),
        optimize_prompt_mode: get_str("optimize_prompt_mode"),
        background: get_str("background"),
        web_search: get_bool("web_search"),
        layer_decomposition: get_bool("layer_decomposition"),
        size: get_str("size"),
        params: free,
        refs,
        loras: parse_loras(obj.get("loras")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lora(repo: &str, weight: &str) -> LoraEntryDto {
        LoraEntryDto {
            repo: repo.to_string(),
            weight: weight.to_string(),
        }
    }

    #[test]
    fn loras_empty_and_blank_repos_ignored() {
        assert_eq!(normalize_loras(&[]), None);
        assert_eq!(normalize_loras(&[lora("  ", "1")]), None);
    }

    #[test]
    fn loras_single_dict_keeps_weight() {
        let v = normalize_loras(&[lora("a/b", "0.8")]).unwrap();
        assert_eq!(v, serde_json::json!({ "a/b": 0.8 }));
    }

    #[test]
    fn loras_single_invalid_weight_defaults_one() {
        assert_eq!(
            normalize_loras(&[lora("a/b", "")]).unwrap(),
            serde_json::json!({ "a/b": 1.0 })
        );
        assert_eq!(
            normalize_loras(&[lora("a/b", "-3")]).unwrap(),
            serde_json::json!({ "a/b": 1.0 })
        );
    }

    #[test]
    fn loras_multi_normalized_sum_one() {
        // 权重 1/2 与 1/4 → 2/3 + 1/3；末项补余数，和恰为 1.00。
        let v = normalize_loras(&[lora("a", "0.5"), lora("b", "0.25")]).unwrap();
        assert_eq!(v, serde_json::json!({ "a": 0.67, "b": 0.33 }));
        let sum: f64 = v
            .as_object()
            .unwrap()
            .values()
            .map(|x| x.as_f64().unwrap())
            .sum();
        assert!((sum - 1.0).abs() < 1e-9);
    }

    #[test]
    fn loras_multi_all_zero_even_split() {
        let v = normalize_loras(&[lora("a", "0"), lora("b", "")]).unwrap();
        assert_eq!(v, serde_json::json!({ "a": 0.5, "b": 0.5 }));
    }

    #[test]
    fn loras_multi_three_item_last_fills_remainder() {
        // 三等分：0.33/0.33/0.34（补余数）。
        let v = normalize_loras(&[lora("a", "1"), lora("b", "1"), lora("c", "1")]).unwrap();
        assert_eq!(v, serde_json::json!({ "a": 0.33, "b": 0.33, "c": 0.34 }));
    }

    #[test]
    fn loras_trailing_zero_weight_stays() {
        // 单条为 0 但多条时保留：0 + 1 → 归一 0 / 1。
        let v = normalize_loras(&[lora("a", "0"), lora("b", "1")]).unwrap();
        assert_eq!(v, serde_json::json!({ "a": 0.0, "b": 1.0 }));
    }

    #[test]
    fn parse_loras_string_and_dict() {
        assert_eq!(
            parse_loras(Some(&serde_json::json!("repo/a"))).unwrap(),
            vec![lora("repo/a", "1")]
        );
        assert_eq!(
            parse_loras(Some(&serde_json::json!({ "repo/a": 0.8, "repo/b": 0.2 }))).unwrap(),
            vec![lora("repo/a", "0.8"), lora("repo/b", "0.2")]
        );
        assert_eq!(parse_loras(None), None);
        assert_eq!(parse_loras(Some(&serde_json::json!("  "))), None);
    }

    #[test]
    fn parse_history_params_full_snapshot() {
        let params = serde_json::json!({
            "size": "2048x2048",
            "n": 4,
            "aspect_ratio": "1:1",
            "quality": "2K",
            "mode": "group",
            "output_format": "jpeg",
            "optimize_prompt_mode": "standard",
            "background": "opaque",
            "web_search": false,
            "layer_decomposition": false,
            "references": ["/data/inputs/a.png"],
            "loras": { "repo/x": 0.6, "repo/y": 0.4 },
            "steps": 30,
            "guidance": 3.5,
            "seed": 123,
            "negative_prompt": "blurry",
        });
        let j = parse_history_params(
            "image",
            "doubao-seedream-5-0-pro-260628",
            "a cat",
            Some(&params.to_string()),
        );
        assert_eq!(j.studio, Studio::Image);
        assert_eq!(j.size.as_deref(), Some("2048x2048"));
        assert_eq!(j.n, Some(4));
        assert_eq!(j.mode.as_deref(), Some("group"));
        assert_eq!(j.quality.as_deref(), Some("2K"));
        assert_eq!(j.ar.as_deref(), Some("1:1"));
        assert_eq!(j.format.as_deref(), Some("jpeg"));
        assert_eq!(j.refs.unwrap(), vec!["/data/inputs/a.png".to_string()]);
        assert_eq!(j.loras.as_ref().unwrap().len(), 2);
        let p = j.params.unwrap();
        assert_eq!(p["steps"], 30);
        assert_eq!(p["guidance"], 3.5);
        assert_eq!(p["seed"], 123);
        assert_eq!(p["negative_prompt"], "blurry");
        assert!(p.get("size").is_none());
    }

    #[test]
    fn parse_history_params_empty_and_free_only() {
        let j = parse_history_params("video", "kling-v3", "p", None);
        assert_eq!(j.studio, Studio::Video);
        assert!(j.params.is_none());
        assert!(j.n.is_none());

        let params = serde_json::json!({ "steps": 30, "guidance": 3.5 });
        let j = parse_history_params("video", "kling-v3", "p", Some(&params.to_string()));
        assert!(j.ar.is_none());
        assert_eq!(j.params.unwrap()["guidance"], 3.5);
    }

    #[test]
    fn structured_keys_single_source() {
        // 前端 freeParams 消费同一常量；键表覆盖所有结构化字段。
        for k in [
            "size",
            "n",
            "aspect_ratio",
            "quality",
            "duration",
            "mode",
            "output_format",
            "optimize_prompt_mode",
            "background",
            "web_search",
            "layer_decomposition",
            "references",
            "loras",
        ] {
            assert!(STRUCTURED_PARAM_KEYS.contains(&k), "缺少键: {k}");
        }
    }
}
