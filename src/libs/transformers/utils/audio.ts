/**
 * @file Helper module for audio processing.
 *
 * These functions and classes are only used internally,
 * meaning an end-user shouldn't need to access anything here.
 *
 * @module utils/audio
 */

import { getFile } from './hub';
import { FFT, max } from './maths';
import { calculateReflectOffset, saveBlob } from './core';
import { Tensor, matmul } from './tensor';
import { apis } from '../env';

/**
 * Helper function to read audio from a path/URL.
 * @param {string|URL} url The path/URL to load the audio from.
 * @param {number} sampling_rate The sampling rate to use when decoding the audio.
 * @returns {Promise<Float32Array>} The decoded audio as a `Float32Array`.
 */
export async function read_audio(url: string | URL, sampling_rate: number) {
  if (typeof AudioContext === 'undefined') {
    // Running in node or an environment without AudioContext
    throw Error(
      'Unable to load audio from path/URL since `AudioContext` is not available in your environment. ' +
        'Instead, audio data should be passed directly to the pipeline/processor. ' +
        'For more information and some example code, see https://huggingface.co/docs/transformers.js/guides/node-audio-processing.',
    );
  }

  var response = await (await getFile(url)).arrayBuffer();
  var audioCTX = new AudioContext({ sampleRate: sampling_rate });
  if (typeof sampling_rate === 'undefined') {
    console.warn(`No sampling rate provided, using default of ${audioCTX.sampleRate}Hz.`);
  }
  var decoded = await audioCTX.decodeAudioData(response);

  /** @type {Float32Array} */
  let audio;

  // We now replicate HuggingFace's `ffmpeg_read` method:
  if (decoded.numberOfChannels === 2) {
    // When downmixing a stereo audio file to mono using the -ac 1 option in FFmpeg,
    // the audio signal is summed across both channels to create a single mono channel.
    // However, if the audio is at full scale (i.e. the highest possible volume level),
    // the summing of the two channels can cause the audio signal to clip or distort.

    // To prevent this clipping, FFmpeg applies a scaling factor of 1/sqrt(2) (~ 0.707)
    // to the audio signal before summing the two channels. This scaling factor ensures
    // that the combined audio signal will not exceed the maximum possible level, even
    // if both channels are at full scale.

    // After applying this scaling factor, the audio signal from both channels is summed
    // to create a single mono channel. It's worth noting that this scaling factor is
    // only applied when downmixing stereo audio to mono using the -ac 1 option in FFmpeg.
    // If you're using a different downmixing method, or if you're not downmixing the
    // audio at all, this scaling factor may not be needed.
    var SCALING_FACTOR = Math.sqrt(2);

    var left = decoded.getChannelData(0);
    var right = decoded.getChannelData(1);

    audio = new Float32Array(left.length);
    for (let i = 0; i < decoded.length; ++i) {
      audio[i] = (SCALING_FACTOR * (left[i] + right[i])) / 2;
    }
  } else {
    // If the audio is not stereo, we can just use the first channel:
    audio = decoded.getChannelData(0);
  }

  return audio;
}

/**
 * Helper function to generate windows that are special cases of the generalized cosine window.
 * See https://www.mathworks.com/help/signal/ug/generalized-cosine-windows.html for more information.
 * @param {number} M Number of points in the output window. If zero or less, an empty array is returned.
 * @param {number} a_0 Offset for the generalized cosine window.
 * @returns {Float64Array} The generated window.
 */
function generalized_cosine_window(M: number, a_0: number) {
  if (M < 1) {
    return new Float64Array();
  }
  if (M === 1) {
    return new Float64Array([1]);
  }

  var a_1 = 1 - a_0;
  var factor = (2 * Math.PI) / (M - 1);

  var cos_vals = new Float64Array(M);
  for (let i = 0; i < M; ++i) {
    cos_vals[i] = a_0 - a_1 * Math.cos(i * factor);
  }
  return cos_vals;
}

/**
 * Generates a Hanning window of length M.
 * See https://numpy.org/doc/stable/reference/generated/numpy.hanning.html for more information.
 *
 * @param {number} M The length of the Hanning window to generate.
 * @returns {Float64Array} The generated Hanning window.
 */
export function hanning(M: number) {
  return generalized_cosine_window(M, 0.5);
}

/**
 * Generates a Hamming window of length M.
 * See https://numpy.org/doc/stable/reference/generated/numpy.hamming.html for more information.
 *
 * @param {number} M The length of the Hamming window to generate.
 * @returns {Float64Array} The generated Hamming window.
 */
export function hamming(M: number) {
  return generalized_cosine_window(M, 0.54);
}

var HERTZ_TO_MEL_MAPPING: { [key: string]: (freq: number) => number } = {
  htk: (freq: number) => 2595.0 * Math.log10(1.0 + freq / 700.0),
  kaldi: (freq: number) => 1127.0 * Math.log(1.0 + freq / 700.0),
  slaney: (freq: number, min_log_hertz = 1000.0, min_log_mel = 15.0, logstep = 27.0 / Math.log(6.4)) =>
    freq >= min_log_hertz ? min_log_mel + Math.log(freq / min_log_hertz) * logstep : (3.0 * freq) / 200.0,
};

/**
 * @template {Float32Array|Float64Array|number} T
 * @param {T} freq
 * @param {string} [mel_scale]
 * @returns {T}
 */
function hertz_to_mel<T extends Float32Array | Float64Array | number>(freq: T, mel_scale = 'htk') {
  var fn = HERTZ_TO_MEL_MAPPING[mel_scale];
  if (!fn) {
    throw new Error('mel_scale should be one of "htk", "slaney" or "kaldi".');
  }

  return typeof freq === 'number' ? fn(freq) : freq.map((x: number) => fn(x));
}

var MEL_TO_HERTZ_MAPPING: { [key: string]: (mels: number) => number } = {
  htk: (mels: number) => 700.0 * (10.0 ** (mels / 2595.0) - 1.0),
  kaldi: (mels: number) => 700.0 * (Math.exp(mels / 1127.0) - 1.0),
  slaney: (mels: number, min_log_hertz = 1000.0, min_log_mel = 15.0, logstep = Math.log(6.4) / 27.0) =>
    mels >= min_log_mel ? min_log_hertz * Math.exp(logstep * (mels - min_log_mel)) : (200.0 * mels) / 3.0,
};

/**
 * @template {Float32Array|Float64Array|number} T
 * @param {T} mels
 * @param {string} [mel_scale]
 * @returns {T}
 */
function mel_to_hertz<T extends Float32Array | Float64Array | number>(mels: T, mel_scale = 'htk') {
  var fn = MEL_TO_HERTZ_MAPPING[mel_scale];
  if (!fn) {
    throw new Error('mel_scale should be one of "htk", "slaney" or "kaldi".');
  }

  return typeof mels === 'number' ? fn(mels) : mels.map((x) => fn(x));
}

/**
 * Creates a triangular filter bank.
 *
 * Adapted from torchaudio and librosa.
 *
 * @param {Float64Array} fft_freqs Discrete frequencies of the FFT bins in Hz, of shape `(num_frequency_bins,)`.
 * @param {Float64Array} filter_freqs Center frequencies of the triangular filters to create, in Hz, of shape `(num_mel_filters,)`.
 * @returns {number[][]} of shape `(num_frequency_bins, num_mel_filters)`.
 */
function _create_triangular_filter_bank(fft_freqs: Float64Array, filter_freqs: Float64Array) {
  var filter_diff = Float64Array.from(
    { length: filter_freqs.length - 1 },
    (_, i) => filter_freqs[i + 1] - filter_freqs[i],
  );

  var slopes = Array.from(
    {
      length: fft_freqs.length,
    },
    () => new Array(filter_freqs.length),
  );

  for (let j = 0; j < fft_freqs.length; ++j) {
    var slope = slopes[j];
    for (let i = 0; i < filter_freqs.length; ++i) {
      slope[i] = filter_freqs[i] - fft_freqs[j];
    }
  }

  var numFreqs = filter_freqs.length - 2;
  var ret = Array.from({ length: numFreqs }, () => new Array(fft_freqs.length));

  for (let j = 0; j < fft_freqs.length; ++j) {
    // 201
    var slope = slopes[j];
    for (let i = 0; i < numFreqs; ++i) {
      // 80
      var down = -slope[i] / filter_diff[i];
      var up = slope[i + 2] / filter_diff[i + 1];
      ret[i][j] = Math.max(0, Math.min(down, up));
    }
  }
  return ret;
}

/**
 * Return evenly spaced numbers over a specified interval.
 * @param {number} start The starting value of the sequence.
 * @param {number} end The end value of the sequence.
 * @param {number} num Number of samples to generate.
 * @returns `num` evenly spaced samples, calculated over the interval `[start, stop]`.
 */
function linspace(start: number, end: number, num: number) {
  var step = (end - start) / (num - 1);
  return Float64Array.from({ length: num }, (_, i) => start + step * i);
}

/**
 * Creates a frequency bin conversion matrix used to obtain a mel spectrogram. This is called a *mel filter bank*, and
 * various implementation exist, which differ in the number of filters, the shape of the filters, the way the filters
 * are spaced, the bandwidth of the filters, and the manner in which the spectrum is warped. The goal of these
 * features is to approximate the non-linear human perception of the variation in pitch with respect to the frequency.
 * @param {number} num_frequency_bins Number of frequencies used to compute the spectrogram (should be the same as in `stft`).
 * @param {number} num_mel_filters Number of mel filters to generate.
 * @param {number} min_frequency Lowest frequency of interest in Hz.
 * @param {number} max_frequency Highest frequency of interest in Hz. This should not exceed `sampling_rate / 2`.
 * @param {number} sampling_rate Sample rate of the audio waveform.
 * @param {string} [norm] If `"slaney"`, divide the triangular mel weights by the width of the mel band (area normalization).
 * @param {string} [mel_scale] The mel frequency scale to use, `"htk"` or `"slaney"`.
 * @param {boolean} [triangularize_in_mel_space] If this option is enabled, the triangular filter is applied in mel space rather than frequency space.
 * This should be set to `true` in order to get the same results as `torchaudio` when computing mel filters.
 * @returns {number[][]} Triangular filter bank matrix, which is a 2D array of shape (`num_frequency_bins`, `num_mel_filters`).
 * This is a projection matrix to go from a spectrogram to a mel spectrogram.
 */
export function mel_filter_bank(
  num_frequency_bins: number,
  num_mel_filters: number,
  min_frequency: number,
  max_frequency: number,
  sampling_rate: number,
  norm: string | null = null,
  mel_scale = 'htk',
  triangularize_in_mel_space = false,
) {
  if (norm !== null && norm !== 'slaney') {
    throw new Error('norm must be one of null or "slaney"');
  }

  var mel_min: any = hertz_to_mel(min_frequency, mel_scale);
  var mel_max: any = hertz_to_mel(max_frequency, mel_scale);
  var mel_freqs: any = linspace(mel_min, mel_max, num_mel_filters + 2);

  let filter_freqs: any = mel_to_hertz(mel_freqs, mel_scale);
  let fft_freqs: any; // frequencies of FFT bins in Hz

  if (triangularize_in_mel_space) {
    var fft_bin_width = sampling_rate / (num_frequency_bins * 2);
    fft_freqs = hertz_to_mel(
      Float64Array.from({ length: num_frequency_bins }, (_, i) => i * fft_bin_width),
      mel_scale,
    );
    filter_freqs = mel_freqs;
  } else {
    fft_freqs = linspace(0, Math.floor(sampling_rate / 2), num_frequency_bins);
  }

  var mel_filters = _create_triangular_filter_bank(fft_freqs, filter_freqs);

  if (norm !== null && norm === 'slaney') {
    // Slaney-style mel is scaled to be approx constant energy per channel
    for (let i = 0; i < num_mel_filters; ++i) {
      var filter = mel_filters[i];
      var enorm = 2.0 / (filter_freqs[i + 2] - filter_freqs[i]);
      for (let j = 0; j < num_frequency_bins; ++j) {
        // Apply this enorm to all frequency bins
        filter[j] *= enorm;
      }
    }
  }

  // TODO warn if there is a zero row

  return mel_filters;
}

/**
 * @template {Float32Array|Float64Array} T
 * Pads an array with a reflected version of itself on both ends.
 * @param {T} array The array to pad.
 * @param {number} left The amount of padding to add to the left.
 * @param {number} right The amount of padding to add to the right.
 * @returns {T} The padded array.
 */
function padReflect<T extends Float32Array | Float64Array>(array: T, left: number, right: number) {
  // @ts-ignore
  var padded = new array.constructor(array.length + left + right);
  var w = array.length - 1;

  for (let i = 0; i < array.length; ++i) {
    padded[left + i] = array[i];
  }

  for (let i = 1; i <= left; ++i) {
    padded[left - i] = array[calculateReflectOffset(i, w)];
  }

  for (let i = 1; i <= right; ++i) {
    padded[w + left + i] = array[calculateReflectOffset(w - i, w)];
  }

  return padded;
}

/**
 * Helper function to compute `amplitude_to_db` and `power_to_db`.
 * @template {Float32Array|Float64Array} T
 * @param {T} spectrogram
 * @param {number} factor
 * @param {number} reference
 * @param {number} min_value
 * @param {number} db_range
 * @returns {T}
 */
function _db_conversion_helper<T extends Float32Array | Float64Array>(
  spectrogram: T,
  factor: number,
  reference: number,
  min_value: number,
  db_range: number | null,
) {
  if (reference <= 0) {
    throw new Error('reference must be greater than zero');
  }

  if (min_value <= 0) {
    throw new Error('min_value must be greater than zero');
  }

  reference = Math.max(min_value, reference);

  var logReference = Math.log10(reference);
  for (let i = 0; i < spectrogram.length; ++i) {
    spectrogram[i] = factor * Math.log10(Math.max(min_value, spectrogram[i]) - logReference);
  }

  if (db_range !== null) {
    if (db_range <= 0) {
      throw new Error('db_range must be greater than zero');
    }
    var maxValue = Number(max(spectrogram)[0]) - db_range;
    for (let i = 0; i < spectrogram.length; ++i) {
      spectrogram[i] = Math.max(spectrogram[i], maxValue);
    }
  }

  return spectrogram;
}

/**
 * Converts an amplitude spectrogram to the decibel scale. This computes `20 * log10(spectrogram / reference)`,
 * using basic logarithm properties for numerical stability. NOTE: Operates in-place.
 *
 * The motivation behind applying the log function on the (mel) spectrogram is that humans do not hear loudness on a
 * linear scale. Generally to double the perceived volume of a sound we need to put 8 times as much energy into it.
 * This means that large variations in energy may not sound all that different if the sound is loud to begin with.
 * This compression operation makes the (mel) spectrogram features match more closely what humans actually hear.
 *
 * @template {Float32Array|Float64Array} T
 * @param {T} spectrogram The input amplitude (mel) spectrogram.
 * @param {number} [reference=1.0] Sets the input spectrogram value that corresponds to 0 dB.
 * For example, use `np.max(spectrogram)` to set the loudest part to 0 dB. Must be greater than zero.
 * @param {number} [min_value=1e-5] The spectrogram will be clipped to this minimum value before conversion to decibels,
 * to avoid taking `log(0)`. The default of `1e-5` corresponds to a minimum of -100 dB. Must be greater than zero.
 * @param {number} [db_range=null] Sets the maximum dynamic range in decibels. For example, if `db_range = 80`, the
 * difference between the peak value and the smallest value will never be more than 80 dB. Must be greater than zero.
 * @returns {T} The modified spectrogram in decibels.
 */
function amplitude_to_db(spectrogram: Float32Array | Float64Array, reference = 1.0, min_value = 1e-5, db_range = null) {
  return _db_conversion_helper(spectrogram, 20.0, reference, min_value, db_range);
}

/**
 * Converts a power spectrogram to the decibel scale. This computes `10 * log10(spectrogram / reference)`,
 * using basic logarithm properties for numerical stability. NOTE: Operates in-place.
 *
 * The motivation behind applying the log function on the (mel) spectrogram is that humans do not hear loudness on a
 * linear scale. Generally to double the perceived volume of a sound we need to put 8 times as much energy into it.
 * This means that large variations in energy may not sound all that different if the sound is loud to begin with.
 * This compression operation makes the (mel) spectrogram features match more closely what humans actually hear.
 *
 * Based on the implementation of `librosa.power_to_db`.
 *
 * @template {Float32Array|Float64Array} T
 * @param {T} spectrogram The input power (mel) spectrogram. Note that a power spectrogram has the amplitudes squared!
 * @param {number} [reference=1.0] Sets the input spectrogram value that corresponds to 0 dB.
 * For example, use `np.max(spectrogram)` to set the loudest part to 0 dB. Must be greater than zero.
 * @param {number} [min_value=1e-10] The spectrogram will be clipped to this minimum value before conversion to decibels,
 * to avoid taking `log(0)`. The default of `1e-10` corresponds to a minimum of -100 dB. Must be greater than zero.
 * @param {number} [db_range=null] Sets the maximum dynamic range in decibels. For example, if `db_range = 80`, the
 * difference between the peak value and the smallest value will never be more than 80 dB. Must be greater than zero.
 * @returns {T} The modified spectrogram in decibels.
 */
function power_to_db(
  spectrogram: Float32Array | Float64Array,
  reference = 1.0,
  min_value = 1e-10,
  db_range: number | null = null,
) {
  return _db_conversion_helper(spectrogram, 10.0, reference, min_value, db_range);
}

/**
 * Calculates a spectrogram over one waveform using the Short-Time Fourier Transform.
 *
 * This function can create the following kinds of spectrograms:
 *   - amplitude spectrogram (`power = 1.0`)
 *   - power spectrogram (`power = 2.0`)
 *   - complex-valued spectrogram (`power = None`)
 *   - log spectrogram (use `log_mel` argument)
 *   - mel spectrogram (provide `mel_filters`)
 *   - log-mel spectrogram (provide `mel_filters` and `log_mel`)
 *
 * In this implementation, the window is assumed to be zero-padded to have the same size as the analysis frame.
 * A padded window can be obtained from `window_function()`. The FFT input buffer may be larger than the analysis frame,
 * typically the next power of two.
 *
 * @param {Float32Array|Float64Array} waveform The input waveform of shape `(length,)`. This must be a single real-valued, mono waveform.
 * @param {Float32Array|Float64Array} window The windowing function to apply of shape `(frame_length,)`, including zero-padding if necessary. The actual window length may be
 * shorter than `frame_length`, but we're assuming the array has already been zero-padded.
 * @param {number} frame_length The length of the analysis frames in samples (a.k.a., `fft_length`).
 * @param {number} hop_length The stride between successive analysis frames in samples.
 * @param {Object} options
 * @param {number} [options.fft_length=null] The size of the FFT buffer in samples. This determines how many frequency bins the spectrogram will have.
 * For optimal speed, this should be a power of two. If `null`, uses `frame_length`.
 * @param {number} [options.power=1.0] If 1.0, returns the amplitude spectrogram. If 2.0, returns the power spectrogram. If `null`, returns complex numbers.
 * @param {boolean} [options.center=true] Whether to pad the waveform so that frame `t` is centered around time `t * hop_length`. If `false`, frame
 * `t` will start at time `t * hop_length`.
 * @param {string} [options.pad_mode="reflect"] Padding mode used when `center` is `true`. Possible values are: `"constant"` (pad with zeros),
 * `"edge"` (pad with edge values), `"reflect"` (pads with mirrored values).
 * @param {boolean} [options.onesided=true] If `true`, only computes the positive frequencies and returns a spectrogram containing `fft_length // 2 + 1`
 * frequency bins. If `false`, also computes the negative frequencies and returns `fft_length` frequency bins.
 * @param {number} [options.preemphasis=null] Coefficient for a low-pass filter that applies pre-emphasis before the DFT.
 * @param {number[][]} [options.mel_filters=null] The mel filter bank of shape `(num_freq_bins, num_mel_filters)`.
 * If supplied, applies this filter bank to create a mel spectrogram.
 * @param {number} [options.mel_floor=1e-10] Minimum value of mel frequency banks.
 * @param {string} [options.log_mel=null] How to convert the spectrogram to log scale. Possible options are:
 * `null` (don't convert), `"log"` (take the natural logarithm) `"log10"` (take the base-10 logarithm), `"dB"` (convert to decibels).
 * Can only be used when `power` is not `null`.
 * @param {number} [options.reference=1.0] Sets the input spectrogram value that corresponds to 0 dB. For example, use `max(spectrogram)[0]` to set
 * the loudest part to 0 dB. Must be greater than zero.
 * @param {number} [options.min_value=1e-10] The spectrogram will be clipped to this minimum value before conversion to decibels, to avoid taking `log(0)`.
 * For a power spectrogram, the default of `1e-10` corresponds to a minimum of -100 dB. For an amplitude spectrogram, the value `1e-5` corresponds to -100 dB.
 * Must be greater than zero.
 * @param {number} [options.db_range=null] Sets the maximum dynamic range in decibels. For example, if `db_range = 80`, the difference between the
 * peak value and the smallest value will never be more than 80 dB. Must be greater than zero.
 * @param {boolean} [options.remove_dc_offset=null] Subtract mean from waveform on each frame, applied before pre-emphasis. This should be set to `true` in
 * order to get the same results as `torchaudio.compliance.kaldi.fbank` when computing mel filters.
 * @param {number} [options.max_num_frames=null] If provided, limits the number of frames to compute to this value.
 * @param {number} [options.min_num_frames=null] If provided, ensures the number of frames to compute is at least this value.
 * @param {boolean} [options.do_pad=true] If `true`, pads the output spectrogram to have `max_num_frames` frames.
 * @param {boolean} [options.transpose=false] If `true`, the returned spectrogram will have shape `(num_frames, num_frequency_bins/num_mel_filters)`. If `false`, the returned spectrogram will have shape `(num_frequency_bins/num_mel_filters, num_frames)`.
 * @returns {Promise<Tensor>} Spectrogram of shape `(num_frequency_bins, length)` (regular spectrogram) or shape `(num_mel_filters, length)` (mel spectrogram).
 */
export async function spectrogram(
  waveform: Float32Array | Float64Array,
  window: Float32Array | Float64Array,
  frame_length: number,
  hop_length: number,
  {
    fft_length = null as number | null,
    power = 1.0,
    center = true,
    pad_mode = 'reflect',
    onesided = true,
    preemphasis = null,
    mel_filters = null as number[][] | null,
    mel_floor = 1e-10,
    log_mel = null,
    reference = 1.0,
    min_value = 1e-10,
    db_range = null,
    remove_dc_offset = null,

    // Custom parameters for efficiency reasons
    min_num_frames = null,
    max_num_frames = null,
    do_pad = true,
    transpose = false,
  } = {},
) {
  var window_length = window.length;
  if (fft_length === null) {
    fft_length = frame_length;
  }
  if (frame_length > fft_length) {
    throw Error(`frame_length (${frame_length}) may not be larger than fft_length (${fft_length})`);
  }

  if (window_length !== frame_length) {
    throw new Error(`Length of the window (${window_length}) must equal frame_length (${frame_length})`);
  }

  if (hop_length <= 0) {
    throw new Error('hop_length must be greater than zero');
  }

  if (power === null && mel_filters !== null) {
    throw new Error(
      'You have provided `mel_filters` but `power` is `None`. Mel spectrogram computation is not yet supported for complex-valued spectrogram. ' +
        'Specify `power` to fix this issue.',
    );
  }

  if (center) {
    if (pad_mode !== 'reflect') {
      throw new Error(`pad_mode="${pad_mode}" not implemented yet.`);
    }
    var half_window = Math.floor((fft_length - 1) / 2) + 1;
    waveform = padReflect(waveform, half_window, half_window);
  }

  // split waveform into frames of frame_length size
  let num_frames = Math.floor(1 + Math.floor((waveform.length - frame_length) / hop_length));
  if (min_num_frames !== null && num_frames < min_num_frames) {
    num_frames = min_num_frames;
  }
  var num_frequency_bins = onesided ? Math.floor(fft_length / 2) + 1 : fft_length;

  let d1 = num_frames;
  let d1Max = num_frames;

  // If maximum number of frames is provided, we must either pad or truncate
  if (max_num_frames !== null) {
    if (max_num_frames > num_frames) {
      // input is too short, so we pad
      if (do_pad) {
        d1Max = max_num_frames;
      }
    } else {
      // input is too long, so we truncate
      d1Max = d1 = max_num_frames;
    }
  }

  // Preallocate arrays to store output.
  var fft = new FFT(fft_length);
  var inputBuffer = new Float64Array(fft_length);
  var outputBuffer = new Float64Array(fft.outputBufferSize);
  var transposedMagnitudeData = new Float32Array(num_frequency_bins * d1Max);

  for (let i = 0; i < d1; ++i) {
    // Populate buffer with waveform data
    var offset = i * hop_length;
    var buffer_size = Math.min(waveform.length - offset, frame_length);
    if (buffer_size !== frame_length) {
      // The full buffer is not needed, so we need to reset it (avoid overflow from previous iterations)
      // NOTE: We don't need to reset the buffer if it's full since we overwrite the first
      // `frame_length` values and the rest (`fft_length - frame_length`) remains zero.
      inputBuffer.fill(0, 0, frame_length);
    }

    for (let j = 0; j < buffer_size; ++j) {
      inputBuffer[j] = waveform[offset + j];
    }

    if (remove_dc_offset) {
      let sum = 0;
      for (let j = 0; j < buffer_size; ++j) {
        sum += inputBuffer[j];
      }
      var mean = sum / buffer_size;
      for (let j = 0; j < buffer_size; ++j) {
        inputBuffer[j] -= mean;
      }
    }

    if (preemphasis !== null) {
      // Done in reverse to avoid copies and distructive modification
      for (let j = buffer_size - 1; j >= 1; --j) {
        inputBuffer[j] -= preemphasis * inputBuffer[j - 1];
      }
      inputBuffer[0] *= 1 - preemphasis;
    }

    // Apply window function
    for (let j = 0; j < window.length; ++j) {
      inputBuffer[j] *= window[j];
    }

    fft.realTransform(outputBuffer, inputBuffer);

    // compute magnitudes
    for (let j = 0; j < num_frequency_bins; ++j) {
      var j2 = j << 1;

      // NOTE: We transpose the data here to avoid doing it later
      transposedMagnitudeData[j * d1Max + i] = outputBuffer[j2] ** 2 + outputBuffer[j2 + 1] ** 2;
    }
  }

  if (power !== null && power !== 2) {
    // slight optimization to not sqrt
    var pow = 2 / power; // we use 2 since we already squared
    for (let i = 0; i < transposedMagnitudeData.length; ++i) {
      transposedMagnitudeData[i] **= pow;
    }
  }

  if (!mel_filters) {
    throw new Error('mel_filters must be provided');
  }
  var num_mel_filters = mel_filters.length;

  // Perform matrix multiplication:
  // mel_spec = mel_filters @ magnitudes.T
  //  - mel_filters.shape=(80, 201)
  //  - magnitudes.shape=(3000, 201) => magnitudes.T.shape=(201, 3000)
  //  - mel_spec.shape=(80, 3000)
  let mel_spec = await matmul(
    // TODO: Make `mel_filters` a Tensor during initialization
    new Tensor('float32', mel_filters.flat(), [num_mel_filters, num_frequency_bins] as [number, number]),
    new Tensor('float32', transposedMagnitudeData, [num_frequency_bins, d1Max] as [number, number]),
  );
  if (transpose) {
    mel_spec = mel_spec.transpose(1, 0);
  }

  var mel_spec_data = /** @type {Float32Array} */ mel_spec.data;
  for (let i = 0; i < mel_spec_data.length; ++i) {
    mel_spec_data[i] = Math.max(mel_floor, mel_spec_data[i]);
  }

  if (power !== null && log_mel !== null) {
    var o = Math.min(mel_spec_data.length, d1 * num_mel_filters);
    // NOTE: operates in-place
    switch (log_mel) {
      case 'log':
        for (let i = 0; i < o; ++i) {
          mel_spec_data[i] = Math.log(mel_spec_data[i]);
        }
        break;
      case 'log10':
        for (let i = 0; i < o; ++i) {
          mel_spec_data[i] = Math.log10(mel_spec_data[i]);
        }
        break;
      case 'dB':
        if (power === 1.0) {
          amplitude_to_db(mel_spec_data, reference, min_value, db_range);
        } else if (power === 2.0) {
          power_to_db(mel_spec_data, reference, min_value, db_range);
        } else {
          throw new Error(`Cannot use log_mel option '${log_mel}' with power ${power}`);
        }
        break;
      default:
        throw new Error(`log_mel must be one of null, 'log', 'log10' or 'dB'. Got '${log_mel}'`);
    }
  }

  return mel_spec;
}

/**
 * Returns an array containing the specified window.
 * @param {number} window_length The length of the window in samples.
 * @param {string} name The name of the window function.
 * @param {Object} options Additional options.
 * @param {boolean} [options.periodic=true] Whether the window is periodic or symmetric.
 * @param {number} [options.frame_length=null] The length of the analysis frames in samples.
 * Provide a value for `frame_length` if the window is smaller than the frame length, so that it will be zero-padded.
 * @param {boolean} [options.center=true] Whether to center the window inside the FFT buffer. Only used when `frame_length` is provided.
 * @returns {Float64Array} The window of shape `(window_length,)` or `(frame_length,)`.
 */
export function window_function(
  window_length: number,
  name: string,
  { periodic = true, frame_length = null, center = true } = {},
) {
  var length = periodic ? window_length + 1 : window_length;
  let window;
  switch (name) {
    case 'boxcar':
      window = new Float64Array(length).fill(1.0);
      break;
    case 'hann':
    case 'hann_window':
      window = hanning(length);
      break;
    case 'hamming':
      window = hamming(length);
      break;
    case 'povey':
      window = hanning(length).map((x) => Math.pow(x, 0.85));
      break;
    default:
      throw new Error(`Unknown window type ${name}.`);
  }
  if (periodic) {
    window = window.subarray(0, window_length);
  }
  if (frame_length === null) {
    return window;
  }
  if (window_length > frame_length) {
    throw new Error(`Length of the window (${window_length}) may not be larger than frame_length (${frame_length})`);
  }

  return window;
}

/**
 * Encode audio data to a WAV file.
 * WAV file specs : https://en.wikipedia.org/wiki/WAV#WAV_File_header
 * 
 * Adapted from https://www.npmjs.com/package/audiobuffer-to-wav
 * @param {Float32Array} samples The audio samples.
 * @param {number} rate The sample rate.
 * @returns {ArrayBuffer} The WAV audio buffer.
 */
function encodeWAV(samples: Float32Array, rate: number) {
  let offset = 44;
  var buffer = new ArrayBuffer(offset + samples.length * 4);
  var view = new DataView(buffer);

  /* RIFF identifier */
  writeString(view, 0, "RIFF");
  /* RIFF chunk length */
  view.setUint32(4, 36 + samples.length * 4, true);
  /* RIFF type */
  writeString(view, 8, "WAVE");
  /* format chunk identifier */
  writeString(view, 12, "fmt ");
  /* format chunk length */
  view.setUint32(16, 16, true);
  /* sample format (raw) */
  view.setUint16(20, 3, true);
  /* channel count */
  view.setUint16(22, 1, true);
  /* sample rate */
  view.setUint32(24, rate, true);
  /* byte rate (sample rate * block align) */
  view.setUint32(28, rate * 4, true);
  /* block align (channel count * bytes per sample) */
  view.setUint16(32, 4, true);
  /* bits per sample */
  view.setUint16(34, 32, true);
  /* data chunk identifier */
  writeString(view, 36, "data");
  /* data chunk length */
  view.setUint32(40, samples.length * 4, true);

  for (let i = 0; i < samples.length; ++i, offset += 4) {
      view.setFloat32(offset, samples[i], true);
  }

  return buffer;
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; ++i) {
      view.setUint8(offset + i, string.charCodeAt(i));
  }
}


export class RawAudio {

  /**
   * Create a new `RawAudio` object.
   * @param {Float32Array} audio Audio data
   * @param {number} sampling_rate Sampling rate of the audio data
   */
  audio: Float32Array;
  sampling_rate: number;

  constructor(audio: Float32Array, sampling_rate: number) {
      this.audio = audio
      this.sampling_rate = sampling_rate
  }

  /**
   * Convert the audio to a wav file buffer.
   * @returns {ArrayBuffer} The WAV file.
   */
  toWav() {
      return encodeWAV(this.audio, this.sampling_rate)
  }

  /**
   * Convert the audio to a blob.
   * @returns {Blob}
   */
  toBlob() {
      var wav = this.toWav();
      var blob = new Blob([wav], { type: 'audio/wav' });
      return blob;
  }

  toArray() {
    return this.audio;
  }

  /**
   * Save the audio to a wav file.
   * @param {string} path
   */
  async save(path: string) {
      let fn;

      if (apis.IS_BROWSER_ENV) {
          if (apis.IS_WEBWORKER_ENV) {
              throw new Error('Unable to save a file from a Web Worker.')
          }
          fn = saveBlob;
      } else if (apis.IS_FS_AVAILABLE) {
         throw new Error('Unable to save because filesystem is disabled in this environment.')
      } else {
          throw new Error('Unable to save because filesystem is disabled in this environment.')
      }

      await fn(path, this.toBlob())
  }
} 