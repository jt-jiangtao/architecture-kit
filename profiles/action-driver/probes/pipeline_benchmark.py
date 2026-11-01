"""Opt-in X11 pipeline diagnostic. Run inside the desktop with publisher suspended.

No network output or files containing pixels. Source is capped at 60fps, so this
measures sustained live throughput rather than unbounded maximum throughput.
"""
import argparse
from collections import deque
import json
import math
import statistics
import time


PROFILES = {'1080p60': (1920, 1080, 60), '900p60': (1600, 900, 60),
            '720p60': (1280, 720, 60), '1080p50': (1920, 1080, 50)}


def build_pipeline(stage, profile='1080p60', conversion='combined'):
    if stage not in ('capture', 'convert', 'encode', 'packetize'):
        raise ValueError('unknown stage')
    if profile not in PROFILES or (stage == 'capture' and profile in ('900p60', '720p60')):
        raise ValueError('unsupported video profile')
    if conversion not in ('combined', 'separate'):
        raise ValueError('unsupported conversion path')
    width, height, fps = PROFILES[profile]
    result = ('ximagesrc name=capture display-name=:99 use-damage=false '
              f'show-pointer=false ! video/x-raw,width=1920,height=1080,framerate={fps}/1 ! '
              'queue leaky=downstream max-size-buffers=1 max-size-bytes=0 max-size-time=0')
    if stage != 'capture':
        if conversion == 'separate' and width != 1920:
            result += (' ! videoconvert name=convert n-threads=2 ! video/x-raw,format=I420,width=1920,height=1080'
                       f' ! videoscale name=scale n-threads=2 ! video/x-raw,format=I420,width={width},height={height}')
        else:
            converter = 'videoconvert' if width == 1920 else 'videoconvertscale'
            result += f' ! {converter} name=convert n-threads=2 ! video/x-raw,format=I420,width={width},height={height}'
    if stage in ('encode', 'packetize'):
        result += (' ! x264enc name=encoder tune=zerolatency speed-preset=ultrafast '
                   'bitrate=4000 vbv-buf-capacity=100 key-int-max=60 bframes=0 '
                   'threads=4 sliced-threads=true byte-stream=true ! '
                   'video/x-h264,profile=constrained-baseline')
    if stage == 'packetize':
        result += ' ! rtph264pay pt=102 config-interval=-1'
    return result + ' ! fakesink name=output sync=false signal-handoffs=true'


def frame_element(stage):
    return 'encoder' if stage == 'packetize' else 'output'


def distribution(values):
    if not values:
        return None
    if any(not math.isfinite(v) or v < 0 for v in values):
        raise ValueError('invalid measurements')
    values = sorted(values)
    return {'median': statistics.median(values),
            'p95': values[math.ceil(len(values) * .95) - 1], 'max': values[-1]}


def summarize(arrivals, latencies, cpu_seconds):
    if len(arrivals) < 2 or any(not math.isfinite(v) for v in arrivals):
        raise ValueError('insufficient frames')
    gaps = [b - a for a, b in zip(arrivals, arrivals[1:])]
    if min(gaps) <= 0 or not math.isfinite(cpu_seconds) or cpu_seconds < 0:
        raise ValueError('invalid time interval')
    duration = arrivals[-1] - arrivals[0]
    return {'frames': len(arrivals), 'seconds': duration,
            'fps': (len(arrivals) - 1) / duration,
            'cpuPercent': 100 * cpu_seconds / duration,
            'gapMs': distribution([g * 1000 for g in gaps]),
            'gapsOver50ms': sum(g > .05 for g in gaps),
            'latencyMs': distribution(latencies)}


def run(stage, seconds=25, warmup=3, profile='1080p60', conversion='combined'):
    if not 5 <= seconds <= 120 or not 1 <= warmup <= 10:
        raise ValueError('duration outside diagnostic bounds')
    import gi
    gi.require_version('Gst', '1.0')
    from gi.repository import Gst, GLib
    Gst.init(None)
    pipeline = Gst.parse_launch(build_pipeline(stage, profile, conversion))
    loop = GLib.MainLoop()
    arrivals, captures, errors = [], [], []
    stages = {}
    active = False
    cpu_start = None

    def frame(sink, buffer, pad):
        if active:
            arrivals.append(time.monotonic())

    def capture(pad, info):
        if active:
            captures.append(time.monotonic())
        return Gst.PadProbeReturn.OK

    if frame_element(stage) == 'output':
        pipeline.get_by_name('output').connect('handoff', frame)
    else:
        def encoded_frame(pad, info):
            if active:
                arrivals.append(time.monotonic())
            return Gst.PadProbeReturn.OK
        pipeline.get_by_name('encoder').get_static_pad('src').add_probe(Gst.PadProbeType.BUFFER, encoded_frame)
    pipeline.get_by_name('capture').get_static_pad('src').add_probe(Gst.PadProbeType.BUFFER, capture)
    for name in ('convert', 'scale', 'encoder'):
        element = pipeline.get_by_name(name)
        if element is None:
            continue
        pending, durations = deque(), []
        stages[name] = durations

        def before(pad, info, pending=pending):
            pending.append(time.monotonic())
            return Gst.PadProbeReturn.OK

        def after(pad, info, pending=pending, durations=durations):
            if pending:
                start = pending.popleft()
                if active:
                    durations.append((time.monotonic() - start) * 1000)
            return Gst.PadProbeReturn.OK

        element.get_static_pad('sink').add_probe(Gst.PadProbeType.BUFFER, before)
        element.get_static_pad('src').add_probe(Gst.PadProbeType.BUFFER, after)

    def begin():
        nonlocal active, cpu_start
        cpu_start = time.process_time()
        active = True
        return False

    def finish():
        loop.quit()
        return False

    def message(bus, msg):
        if msg.type == Gst.MessageType.ERROR:
            error, debug = msg.parse_error()
            errors.append(str(error))
            loop.quit()

    bus = pipeline.get_bus()
    bus.add_signal_watch()
    bus.connect('message', message)
    timers = [GLib.timeout_add(warmup * 1000, begin),
              GLib.timeout_add((warmup + seconds) * 1000, finish)]
    try:
        pipeline.set_state(Gst.State.PLAYING)
        loop.run()
        elapsed_cpu = time.process_time() - cpu_start if cpu_start is not None else 0
        active = False
        if errors:
            raise RuntimeError('; '.join(errors))
        result = summarize(arrivals, [], elapsed_cpu)
        capture_caps = pipeline.get_by_name('capture').get_static_pad('src').get_current_caps()
        converted = pipeline.get_by_name('convert')
        final_raw = pipeline.get_by_name('scale') or converted
        converted_caps = final_raw.get_static_pad('src').get_current_caps() if final_raw else capture_caps
        actual = converted_caps.get_structure(0)
        dimensions = (actual.get_value('width'), actual.get_value('height'))
        if dimensions != PROFILES[profile][:2]:
            raise RuntimeError('negotiated video dimensions differ from requested profile')
        result.update(stage=stage, sourceFrames=len(captures),
                      sourceFps=(len(captures)-1)/(captures[-1]-captures[0]) if len(captures)>1 else None,
                      stagesMs={key: distribution(value) for key, value in stages.items()},
                      sourceOutputCountDeltaApprox=len(captures)-len(arrivals),
                      countBoundaryToleranceFrames=1,
                      warmupSeconds=warmup, dimensions=f'{PROFILES[profile][0]}x{PROFILES[profile][1]}',
                      profile=profile, logicalDesktop='1920x1080',
                      conversion=conversion,
                      intermediateCaps=converted.get_static_pad('src').get_current_caps().to_string() if converted else None,
                      captureCaps=capture_caps.to_string(), convertedCaps=converted_caps.to_string(),
                      method='60fps live source; fakesink; lightweight Python pad probes; process CPU only')
        return result
    finally:
        active = False
        pipeline.set_state(Gst.State.NULL)
        bus.remove_signal_watch()
        context = GLib.MainContext.default()
        for timer in timers:
            source = context.find_source_by_id(timer)
            if source:
                source.destroy()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stage', choices=['capture', 'convert', 'encode', 'packetize'])
    parser.add_argument('--seconds', type=int, default=25)
    parser.add_argument('--profile', choices=list(PROFILES), default='1080p60')
    parser.add_argument('--conversion', choices=['combined', 'separate'], default='combined')
    args = parser.parse_args()
    print(json.dumps(run(args.stage, args.seconds, profile=args.profile, conversion=args.conversion)), flush=True)
