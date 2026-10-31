//! Optional synchronous image kernels for app-qa. PNG parsing and inflate stay in Node.
//! Inputs are borrowed only for this call. Shared backing must not be mutated during a call.
use napi::{bindgen_prelude::*, Error, Result};
use napi_derive::napi;

#[napi]
pub fn api_version() -> u32 {
    1
}

#[napi(object)]
pub struct ColorStats {
    pub dominant_share: f64,
    pub red_share: f64,
}

fn dimensions(width: u32, height: u32, bytes: usize) -> Result<(usize, usize)> {
    let (w, h) = (width as usize, height as usize);
    if w.checked_mul(h)
        .and_then(|v| v.checked_mul(3))
        .is_none_or(|n| n > bytes)
    {
        return Err(Error::from_reason(
            "image RGB buffer is shorter than its dimensions",
        ));
    }
    Ok((w, h))
}

/// Same scanline unfilter / high-byte RGB extraction as runner/image.ts at 86d5685.
#[napi]
pub fn decode_rgb(
    width: u32,
    height: u32,
    depth: u32,
    color: u32,
    raw: &[u8],
    palette: &[u8],
) -> Result<Option<Uint8Array>> {
    let channels = match color {
        0 => 1,
        2 => 3,
        3 => 1,
        4 => 2,
        6 => 4,
        _ => return Ok(None),
    };
    if width == 0 || height == 0 || ![8, 16].contains(&depth) || (color == 3 && depth != 8) {
        return Ok(None);
    }
    let (w, h) = (width as usize, height as usize);
    let step = depth as usize / 8;
    let bpp = channels * step;
    let Some(stride) = w.checked_mul(bpp) else {
        return Ok(None);
    };
    let Some(required) = stride.checked_add(1).and_then(|v| v.checked_mul(h)) else {
        return Ok(None);
    };
    if raw.len() < required {
        return Ok(None);
    }
    let Some(rgb_len) = w.checked_mul(h).and_then(|v| v.checked_mul(3)) else {
        return Ok(None);
    };
    let mut rgb = Vec::new();
    rgb.try_reserve_exact(rgb_len)
        .map_err(|e| Error::from_reason(e.to_string()))?;
    rgb.resize(rgb_len, 0);
    let mut prev = vec![0u8; stride];
    let mut line = vec![0u8; stride];
    for y in 0..h {
        let start = y * (stride + 1);
        let filter = raw[start];
        for i in 0..stride {
            let x = raw[start + 1 + i] as i32;
            let a = if i >= bpp { line[i - bpp] as i32 } else { 0 };
            let b = prev[i] as i32;
            let c = if i >= bpp { prev[i - bpp] as i32 } else { 0 };
            let v = match filter {
                0 => x,
                1 => x + a,
                2 => x + b,
                3 => x + ((a + b) >> 1),
                4 => {
                    let p = a + b - c;
                    let (pa, pb, pc) = ((p - a).abs(), (p - b).abs(), (p - c).abs());
                    x + if pa <= pb && pa <= pc {
                        a
                    } else if pb <= pc {
                        b
                    } else {
                        c
                    }
                }
                _ => return Ok(None),
            };
            line[i] = (v & 255) as u8;
        }
        for px in 0..w {
            let s = px * bpp;
            let o = (y * w + px) * 3;
            if color == 3 {
                let idx = line[s] as usize * 3;
                for k in 0..3 {
                    rgb[o + k] = *palette.get(idx + k).unwrap_or(&0);
                }
            } else if channels <= 2 {
                rgb[o..o + 3].fill(line[s]);
            } else {
                rgb[o] = line[s];
                rgb[o + 1] = line[s + step];
                rgb[o + 2] = line[s + 2 * step];
            }
        }
        std::mem::swap(&mut prev, &mut line);
    }
    Ok(Some(rgb.into()))
}

#[napi]
pub fn d_hash(width: u32, height: u32, rgb: &[u8]) -> Result<String> {
    let (w, h) = dimensions(width, height, rgb.len())?;
    let mut sums = [0.0f64; 72];
    let mut counts = [0u32; 72];
    for y in (0..h).step_by(2) {
        let cy = (y * 8 / h).min(7);
        for x in (0..w).step_by(2) {
            let cx = (x * 9 / w).min(8);
            let o = (y * w + x) * 3;
            // Preserve JS IEEE754 operation order; no fast-math / FMA.
            sums[cy * 9 + cx] +=
                0.299 * rgb[o] as f64 + 0.587 * rgb[o + 1] as f64 + 0.114 * rgb[o + 2] as f64;
            counts[cy * 9 + cx] = counts[cy * 9 + cx].wrapping_add(1);
        }
    }
    let mut bits = 0u64;
    for y in 0..8 {
        for x in 0..8 {
            let i = y * 9 + x;
            let a = sums[i] / counts[i].max(1) as f64;
            let b = sums[i + 1] / counts[i + 1].max(1) as f64;
            bits = (bits << 1) | u64::from(a > b);
        }
    }
    Ok(format!("{bits:016x}"))
}

#[napi]
pub fn color_stats(width: u32, height: u32, rgb: &[u8]) -> Result<ColorStats> {
    let (w, h) = dimensions(width, height, rgb.len())?;
    let mut buckets = [0u32; 32768];
    let (mut total, mut red, mut top) = (0u64, 0u64, 0u32);
    for y in (0..h).step_by(4) {
        for x in (0..w).step_by(4) {
            let o = (y * w + x) * 3;
            let (r, g, b) = (rgb[o], rgb[o + 1], rgb[o + 2]);
            let key =
                (((r as usize) >> 3) << 10) | (((g as usize) >> 3) << 5) | ((b as usize) >> 3);
            buckets[key] += 1;
            top = top.max(buckets[key]);
            if r >= 150 && g <= 90 && b <= 90 {
                red += 1;
            }
            total += 1;
        }
    }
    Ok(ColorStats {
        dominant_share: if total > 0 {
            top as f64 / total as f64
        } else {
            0.0
        },
        red_share: if total > 0 {
            red as f64 / total as f64
        } else {
            0.0
        },
    })
}
