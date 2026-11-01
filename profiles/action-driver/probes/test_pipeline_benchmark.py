import importlib.util
import unittest
from pathlib import Path

PATH = Path(__file__).with_name('pipeline_benchmark.py')
spec = importlib.util.spec_from_file_location('pipeline_benchmark', PATH)
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


class PipelineBenchmarkTests(unittest.TestCase):
    def test_stages_add_only_conversion_then_encoding(self):
        capture = bench.build_pipeline('capture')
        convert = bench.build_pipeline('convert')
        encode = bench.build_pipeline('encode')
        self.assertNotIn('videoconvert', capture)
        self.assertNotIn('x264enc', convert)
        self.assertIn('videoconvert', convert)
        self.assertIn('x264enc', encode)
        for pipeline in [capture, convert, encode]:
            self.assertIn('framerate=60/1', pipeline)
            self.assertIn('max-size-buffers=1', pipeline)
            self.assertIn('sync=false', pipeline)
            self.assertNotIn('webrtc', pipeline)
        self.assertIn('bitrate=4000', encode)
        self.assertIn('bframes=0', encode)

    def test_unknown_stage_is_rejected_before_gstreamer(self):
        with self.assertRaises(ValueError):
            bench.build_pipeline('capture ! filesink location=/workspace/x')

    def test_packetization_counts_encoded_frames_instead_of_rtp_packets(self):
        pipeline = bench.build_pipeline('packetize')
        self.assertIn('rtph264pay', pipeline)
        self.assertEqual(bench.frame_element('packetize'), 'encoder')
        self.assertEqual(bench.frame_element('encode'), 'output')
        self.assertNotIn('webrtc', pipeline)

    def test_quality_trials_keep_native_capture_and_bound_video_profiles(self):
        lower = bench.build_pipeline('packetize', '900p60')
        self.assertIn('width=1920,height=1080,framerate=60/1', lower)
        self.assertIn('videoconvertscale', lower)
        self.assertIn('format=I420,width=1600,height=900', lower)
        self.assertIn('framerate=50/1', bench.build_pipeline('encode', '1080p50'))
        self.assertIn('format=I420,width=1280,height=720', bench.build_pipeline('encode', '720p60'))
        for profile in ['320p60', '900p ! filesink', None]:
            with self.assertRaises(ValueError):
                bench.build_pipeline('encode', profile)

    def test_capture_does_not_claim_a_scaled_resolution_without_conversion(self):
        with self.assertRaises(ValueError):
            bench.build_pipeline('capture', '900p60')

    def test_copy_comparison_keeps_the_same_target_but_exposes_intermediate_buffer(self):
        fused = bench.build_pipeline('packetize', '720p60', conversion='combined')
        split = bench.build_pipeline('packetize', '720p60', conversion='separate')
        self.assertIn('videoconvertscale', fused)
        self.assertIn('videoconvert name=convert', split)
        self.assertIn('videoscale name=scale', split)
        self.assertIn('format=I420,width=1920,height=1080', split)
        self.assertIn('format=I420,width=1280,height=720', split)
        with self.assertRaises(ValueError):
            bench.build_pipeline('packetize', '720p60', conversion='external-command')

    def test_fps_counts_intervals_not_sample_count(self):
        result = bench.summarize([10, 10.02, 10.04], [2, 4, 6], 0.02)
        self.assertAlmostEqual(result['fps'], 50)
        self.assertAlmostEqual(result['cpuPercent'], 50)
        self.assertEqual(result['latencyMs']['p95'], 6)

    def test_empty_or_unordered_samples_never_report_success(self):
        for values in [[], [1], [1, 1], [2, 1]]:
            with self.assertRaises(ValueError):
                bench.summarize(values, [], 1)

    def test_nonfinite_or_negative_latency_is_rejected(self):
        for latency in [[-1], [float('nan')], [float('inf')]]:
            with self.assertRaises(ValueError):
                bench.summarize([1, 2], latency, 1)

    def test_output_gaps_expose_stalls_even_when_mean_is_healthy(self):
        result = bench.summarize([1, 1.01, 1.02, 1.22], [], 0.1)
        self.assertAlmostEqual(result['gapMs']['max'], 200)
        self.assertEqual(result['gapsOver50ms'], 1)


if __name__ == '__main__':
    unittest.main()
