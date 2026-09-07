"""Valorant live game-state watcher.

Tails Riot's own ShooterGame.log (%LocalAppData%/VALORANT/Saved/Logs) the same
way Overwolf/gigi do: plain-text file, read-only, byte-offset follow, regex
matchers for match lifecycle, map, agent, mode, rounds and the local player's
kill/death voice-line barks. No API keys, no memory reading, no injection.

Emits events into the collector buffer with device='game' so they share the
exact same perf_counter clock as mouse/keyboard events and land inside the
session timeline automatically.

Kill/death/headshot detection is voice-line based (Play_VO_<agent>_*) and is
therefore approximate: it fires on the agent's bark, which may not trigger on
every kill and can lag by a moment. Rounds, map, mode and match lifecycle come
from deterministic log lines.
"""
import os
import re
import sys
import time
import threading
from pathlib import Path

# Internal codename -> display name (verified against valorant-api.com/v1/maps)
MAP_NAMES = {
    'Ascent': 'Ascent', 'Bonsai': 'Split', 'Canyon': 'Fracture', 'Duality': 'Bind',
    'Foxtrot': 'Breeze', 'Infinity': 'Abyss', 'Jam': 'Lotus', 'Juliett': 'Sunset',
    'Pitt': 'Pearl', 'Plummet': 'Summit', 'Port': 'Icebox', 'Poveglia': 'The Range',
    'PovegliaV2': 'The Range', 'Rook': 'Corrode', 'Triad': 'Haven', 'HURM': 'Team Deathmatch',
    'NPEV2': 'Basic Training',
}
# Internal codename -> display name (verified against valorant-api.com/v1/agents)
AGENT_NAMES = {
    'AggroBot': 'Gekko', 'BountyHunter': 'Fade', 'Breach': 'Breach', 'Cable': 'Deadlock',
    'Cashew': 'Tejo', 'Clay': 'Raze', 'Deadeye': 'Chamber', 'Grenadier': 'KAY/O',
    'Guide': 'Skye', 'Gumshoe': 'Cypher', 'Hunter': 'Sova', 'Iris': 'Miks',
    'Killjoy': 'Killjoy', 'Mage': 'Harbor', 'Nox': 'Vyse', 'Pandemic': 'Viper',
    'Phoenix': 'Phoenix', 'Pine': 'Veto', 'Rift': 'Astra', 'Sarge': 'Brimstone',
    'Sequoia': 'Iso', 'Smonk': 'Clove', 'Sprinter': 'Neon', 'Stealth': 'Yoru',
    'Terra': 'Waylay', 'Thorne': 'Sage', 'Vampire': 'Reyna', 'Wraith': 'Omen',
    'Wushu': 'Jett',
}
MODE_NAMES = {
    'bomb': 'Standard', 'quickbomb': 'Spike Rush', 'gungame': 'Deathmatch',
    'escalation': 'Escalation', 'oneway': 'Team Deathmatch', 'hurm': 'Team Deathmatch',
}

RE_MATCH_START = re.compile(r'Reconcile called with the current state: InGame')
RE_MATCH_END = re.compile(r'Reconcile called with the current state: MainMenu')
RE_TRANSITION_INGAME = re.compile(r'Reconcile called with the current state: TransitionToInGame and new state: InGame')
RE_WAITING_POST = re.compile(r'Reconcile called with the current state: InGame and new state:.*Scheduling a reconcile')
RE_SCENE = re.compile(r'Map Name:\s*([^\|\]]+)')
RE_AGENT = re.compile(r'Current character:\s+Default__([A-Za-z0-9]+)_PC_C')
RE_MODE = re.compile(r'/Game/GameModes/([^/\s]+)')
RE_MATCH_ID = re.compile(r'MatchId:\s*([a-f0-9-]{36})')
RE_PLAYER_ID = re.compile(r'Logged in user changed:\s*([a-f0-9-]{36})')
RE_PLAYER_NAME = re.compile(r'\?Name=([^?\s]+)#(\d+)')
RE_ROUND_SHOPPING = re.compile(r'Gameplay started at local time\s+(0\.0[\d]*)\s+\(server time 0\.000000\)', re.I)
RE_ROUND_COMBAT = re.compile(r'Gameplay started at local time\s+([\d.]+)\s+\(server time', re.I)
RE_ROUND_END = re.compile(r"OnRoundEnded for round\s+'(\d+)'", re.I)
RE_VO_HEADSHOT = re.compile(r'Play_VO_[A-Za-z0-9_]+HeadshotKill', re.I)

RANGE_SCENES = ('Poveglia', 'PovegliaV2')


def default_log_path():
    local = os.environ.get('LOCALAPPDATA', '')
    return Path(local) / 'VALORANT' / 'Saved' / 'Logs' / 'ShooterGame.log'


def map_display(codename):
    if not codename:
        return None
    return MAP_NAMES.get(codename, codename)


def agent_display(codename):
    if not codename:
        return None
    return AGENT_NAMES.get(codename, codename)


def mode_display(codename):
    if not codename:
        return None
    return MODE_NAMES.get(codename.lower(), codename)


class ValorantWatcher:
    """Tails ShooterGame.log and maintains a game snapshot + game events."""

    def __init__(self, record, log_path=None, poll=0.4):
        self.record = record          # record(device, type, data) -> collector buffer
        self.poll = poll
        self.log_path = Path(log_path or os.environ.get('MOUSE_STATS_VALORANT_LOG') or default_log_path())
        self._offset = 0
        self._tail = b''
        self._lock = threading.Lock()
        self._phase = 'menu'          # menu | agent_select | live | postmatch
        self._map = None              # internal codename
        self._agent = None            # lowercased codename for VO matching
        self._agent_raw = None
        self._vo = None               # compiled voice-line regexes for the agent
        self._mode = None
        self._match_id = None
        self._round = 1
        self._player_id = None
        self._player_name = None
        self._ended = False
        self._changed_monotonic = 0.0

    # ---- snapshot for /health -------------------------------------------------
    def snapshot(self):
        with self._lock:
            return {
                'phase': self._phase,
                'inMatch': self._phase in ('agent_select', 'live'),
                'map': map_display(self._map),
                'mapCodename': self._map,
                'agent': agent_display(self._agent_raw) if self._agent_raw else None,
                'mode': mode_display(self._mode),
                'matchId': self._match_id,
                'round': self._round,
                'playerName': self._player_name,
                'playerId': self._player_id,
                'logPath': str(self.log_path),
                'logFound': self.log_path.exists(),
                'changedAtMonotonic': self._changed_monotonic,
            }

    # ---- event helpers --------------------------------------------------------
    def _touch(self):
        self._changed_monotonic = time.perf_counter()

    def _emit(self, kind, data):
        with self._lock:
            snap = {
                'phase': self._phase, 'round': self._round, 'map': map_display(self._map),
                'agent': agent_display(self._agent_raw) if self._agent_raw else None,
                'mode': mode_display(self._mode), 'matchId': self._match_id,
            }
        snap.update(data)
        snap['kind'] = kind
        self.record('game', 'game_' + kind, snap)
        self._touch()

    def _set_phase(self, phase):
        if self._phase != phase:
            self._phase = phase
            self._touch()

    def _reset_match(self):
        self._map = None
        self._mode = None
        self._match_id = None
        self._round = 1

    def _set_agent(self, codename):
        self._agent_raw = codename
        self._agent = codename.lower()
        self._vo = {
            'kill': re.compile(r'Play_VO_' + self._agent + r'(_E\d+)?_Kill(?![a-zA-Z])', re.I),
            'death': re.compile(r'Play_VO_' + self._agent + r'_DeathEffort', re.I),
            'headshot': re.compile(r'Play_VO_' + self._agent + r'(_E\d+)?(_HeadshotKill(_\d+)?)', re.I),
        }

    # ---- parsing --------------------------------------------------------------
    def _process_line(self, line):
        m = RE_PLAYER_ID.search(line)
        if m:
            self._player_id = m.group(1)
        m = RE_PLAYER_NAME.search(line)
        if m and not self._player_name:
            self._player_name = f'{m.group(1)}#{m.group(2)}'
        m = RE_MATCH_ID.search(line)
        if m and self._phase in ('agent_select', 'live', 'postmatch') and self._match_id != m.group(1):
            self._match_id = m.group(1)

        # Scene changes drive agent-select detection and menu state.
        m = RE_SCENE.search(line)
        if m:
            scene = m.group(1).strip()
            if scene in ('mainmenuv2', 'lobby', 'MainMenu'):
                if self._phase != 'menu':
                    self._set_phase('menu')
                    self._reset_match()
                    self._emit('match_end', {'reason': 'mainmenu'})
            elif scene == 'characterselectpersistentlevel':
                if self._phase not in ('agent_select', 'live'):
                    self._reset_match()
                    self._ended = False
                    self._set_phase('agent_select')
                    self._emit('agent_select', {})
            elif scene == 'init':
                pass
            elif scene in RANGE_SCENES:
                # The Range is practice, not a captured match.
                if self._phase == 'live' and self._map != scene:
                    self._map = scene
                    self._emit('map', {'mapCodename': scene})
            else:
                if self._phase in ('agent_select', 'live', 'postmatch'):
                    if self._map != scene:
                        self._map = scene
                        self._emit('map', {'mapCodename': scene})
                elif self._phase == 'menu':
                    # Direct map load without character select (deathmatch/custom flows).
                    self._reset_match()
                    self._ended = False
                    self._set_phase('agent_select')
                    self._map = scene
                    self._emit('agent_select', {})
                    self._emit('map', {'mapCodename': scene})

        m = RE_AGENT.search(line)
        if m and m.group(1) != self._agent_raw:
            self._set_agent(m.group(1))

        m = RE_MODE.search(line)
        if m and not m.group(1).endswith('_development'):
            self._mode = m.group(1)

        m = RE_ROUND_SHOPPING.search(line)
        if m:
            self._emit('round_start', {'round': self._round})
        else:
            m = RE_ROUND_COMBAT.search(line)
            if m and float(m.group(1)) > 10:
                self._emit('round_combat', {'round': self._round})

        m = RE_ROUND_END.search(line)
        if m:
            self._emit('round_end', {'round': self._round, 'endedNumber': int(m.group(1))})
            self._round = int(m.group(1)) + 2  # Overwolf off-by-two convention

        if RE_WAITING_POST.search(line):
            if self._phase == 'live' and not self._ended:
                self._set_phase('postmatch')
                self._ended = True
                self._emit('match_end', {'reason': 'postmatch'})
        elif RE_TRANSITION_INGAME.search(line):
            self._set_phase('live')
        elif RE_MATCH_END.search(line):
            if self._phase != 'menu':
                first_end = not self._ended
                self._set_phase('menu')
                self._reset_match()
                self._ended = True
                if first_end:
                    self._emit('match_end', {'reason': 'mainmenu'})
        elif RE_MATCH_START.search(line):
            self._set_phase('live')
            self._emit('match_start', {})

        # Voice-line kill/death/headshot (approximate, local agent only).
        if self._vo and self._phase in ('agent_select', 'live', 'postmatch'):
            if self._vo['death'].search(line):
                self._emit('death', {'source': 'vo'})
            elif self._vo['headshot'].search(line):
                self._emit('kill', {'source': 'vo', 'headshot': True})
                self._emit('headshot', {'source': 'vo'})
            elif self._vo['kill'].search(line):
                self._emit('kill', {'source': 'vo'})

    # ---- tailing ---------------------------------------------------------------
    def _read_lines(self):
        try:
            size = self.log_path.stat().st_size
        except OSError:
            return []
        if size < self._offset:  # rotated / truncated
            self._offset = 0
            self._tail = b''
        if size == self._offset:
            return []
        lines = []
        try:
            with open(self.log_path, 'rb') as f:
                f.seek(self._offset)
                chunk = f.read(min(size - self._offset, 4 * 1024 * 1024))
            self._offset += len(chunk)
            data = self._tail + chunk
            *complete, self._tail = data.split(b'\n')
            for raw in complete:
                lines.append(raw.decode('utf-8', 'replace').rstrip('\r'))
        except OSError:
            return []
        return lines

    def _tick(self):
        for line in self._read_lines():
            try:
                self._process_line(line)
            except Exception:
                continue

    def run(self):
        if sys.platform != 'win32' and not os.environ.get('MOUSE_STATS_VALORANT_LOG'):
            return
        while True:
            try:
                self._tick()
            except Exception:
                pass
            time.sleep(self.poll)
