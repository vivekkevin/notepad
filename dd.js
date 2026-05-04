import concurrent.futures
import pandas as pd
import difflib
import requests
import time
import re
import os
import json
import numpy as np
from datetime import datetime
from geopy.distance import geodesic
from itertools import combinations

# =========================================================
#  COMBINED PIPELINE SCRIPT
#  1. Forward Geocoding      (Google Places API + Geocode API fallback)
#  2. Building Classification (Shared / Exclusive)
#  3. Proximity Flagging      (300m threshold, per Issuer)
# =========================================================

# =========================================================
# SECTION 0 — CONFIG IMPORT
# =========================================================
try:
    from config import (
        SEARCH_URL, GOOGLE_API_KEY, RATE_LIMIT_DELAY, DIR_GEOCODE
    )
except ImportError:
    print(&quot;❌ ERROR: Could not import from config.py&quot;)
    raise

# Google Maps Geocoding API endpoint (fallback)
GEOCODE_URL = &quot;https://maps.googleapis.com/maps/api/geocode/json&quot;

# ─────────────────────────────────────────────────────────
# FORWARD GEOCODE — Column Mappings
# ─────────────────────────────────────────────────────────
COL_ISSUER_E          = 'ISSUER_NAME'
COL_NAME_F            = 'LOCATION_NAME'
COL_ADDR_G            = 'LOCATION_ADDRESS'
COL_ASSET_H           = 'ACTIVITY_AT_ASSET'
COL_COUNTRY_I         = 'COUNTRY'
COL_STATE_L           = 'STATE'
COL_CITY_M            = 'CITY'
COL_CODE_K            = 'POSTCODE'
COL_LAT_P             = 'LATITUDE'
COL_LON_Q             = 'LONGITUDE'
COL_QUERY_SENT        = 'QUERY_ADDRESS_SENT'
COL_FOUND_ADDR_S      = 'FOUND_ADDRESS'
COL_CONFIDENCE        = 'MATCH_CONFIDENCE'
COL_MATCH_TYPE        = 'MATCH_TYPE'
COL_RESULTS_COUNT     = 'SEARCH_RESULTS_COUNT'
COL_PROCESSING_STATUS = 'PROCESSING_STATUS'
COL_SOURCE_API        = 'SOURCE_API'
COL_GEOCODE_ACCURACY  = 'GEOCODE_ACCURACY'
COL_RESULT_RANK       = 'RESULT_RANK'

# Checkpoint settings
CHECKPOINT_INTERVAL = 100
CHECKPOINT_FILE     = os.path.join(DIR_GEOCODE, &quot;forward_geocode_checkpoint.json&quot;)

# Debug control
SHOW_DETAILED_SELECTION = True


# =========================================================
# SECTION 1 — FORWARD GEOCODING
# =========================================================

# ─────────────────────────────────────────────────────────
# 1A. SMART QUERY BUILDER
# ─────────────────────────────────────────────────────────

def is_info_in_address(address, info_to_check):
    &quot;&quot;&quot;Check if information is already in address (word boundary match).&quot;&quot;&quot;
    if not address or not info_to_check:
        return False
    address_lower    = address.lower().strip()
    info_lower       = info_to_check.lower().strip()
    pattern          = r'\b' + re.escape(info_lower) + r'\b'
    return bool(re.search(pattern, address_lower))


def build_intelligent_query(row, rank_mode):
    &quot;&quot;&quot;Smart query builder — avoids duplicating city/state/country if already in address.&quot;&quot;&quot;

    def clean(val):
        if val is None or pd.isna(val):
            return ''
        val_str = str(val).strip()
        return '' if val_str.lower() in ['nan', 'none', ''] else val_str

    issuer   = clean(row.get('ISSUER_NAME',      ''))
    loc_name = clean(row.get('LOCATION_NAME',    ''))
    addr     = clean(row.get('LOCATION_ADDRESS', ''))
    asset    = clean(row.get('ACTIVITY_AT_ASSET', ''))
    city     = clean(row.get('CITY',             ''))
    state    = clean(row.get('STATE',            ''))
    country  = clean(row.get('COUNTRY',          ''))

    add_city    = city    and not is_info_in_address(addr, city)
    add_state   = state   and not is_info_in_address(addr, state)
    add_country = country and not is_info_in_address(addr, country)

    query_parts = []

    if rank_mode == &quot;Rank 01&quot;:
        if loc_name:    query_parts.append(loc_name)
        if addr:        query_parts.append(addr)
        if add_city:    query_parts.append(city)
        if add_state:   query_parts.append(state)
        if add_country: query_parts.append(country)

    elif rank_mode == &quot;Rank 02&quot;:
        if issuer:      query_parts.append(issuer)
        if loc_name:    query_parts.append(loc_name)
        if addr:        query_parts.append(addr)
        if asset:       query_parts.append(asset)
        if add_city:    query_parts.append(city)
        if add_state:   query_parts.append(state)
        if add_country: query_parts.append(country)

    elif rank_mode == &quot;Rank 03&quot;:
        if issuer:      query_parts.append(issuer)
        if addr:        query_parts.append(addr)
        if add_city:    query_parts.append(city)
        if add_state:   query_parts.append(state)
        if add_country: query_parts.append(country)

    elif rank_mode == &quot;Rank 04&quot;:
        if addr:        query_parts.append(addr)
        if add_city:    query_parts.append(city)
        if add_state:   query_parts.append(state)
        if add_country: query_parts.append(country)

    query = &quot;, &quot;.join(query_parts)

    if not hasattr(build_intelligent_query, 'debug_count'):
        build_intelligent_query.debug_count = 0
    if build_intelligent_query.debug_count < 3:
        print(f&quot;
[Query Building - {rank_mode}]&quot;)
        print(f&quot;  Issuer: {issuer}&quot;)
        print(f&quot;  Location: {loc_name}&quot;)
        print(f&quot;  Asset: {asset}&quot;) # <--- Add this line
        print(f&quot;  Address: {addr if addr else '(empty)'}&quot;)
        print(f&quot;  City: {city}, State: {state}&quot;)
        print(f&quot;  → Query: {query}&quot;)
        build_intelligent_query.debug_count += 1

    return query


def build_geocode_fallback_query(row):
    &quot;&quot;&quot;
    Fallback query for Geocode API.
    Combines: Issuer Name + Location Name + Address + ZIP + City + State + Country + Activity Type.
    &quot;&quot;&quot;
    def clean(val):
        if val is None or pd.isna(val):
            return ''
        val_str = str(val).strip()
        return '' if val_str.lower() in ['nan', 'none', ''] else val_str

    parts = []
    for field in ['ISSUER_NAME', 'LOCATION_NAME', 'LOCATION_ADDRESS',
                  'POSTCODE', 'CITY', 'STATE', 'COUNTRY', 'ACTIVITY_AT_ASSET']:
        v = clean(row.get(field, ''))
        if v:
            parts.append(v)

    return &quot;, &quot;.join(parts)


# ─────────────────────────────────────────────────────────
# 1B. MULTI-CRITERIA SMART MATCHING
# ─────────────────────────────────────────────────────────

def calculate_similarity(str1, str2):
    &quot;&quot;&quot;Calculate similarity between two strings. Returns score 0–100.&quot;&quot;&quot;
    if not str1 or not str2:
        return 0.0
    s1 = str1.lower().strip()
    s2 = str2.lower().strip()
    if s1 == s2:
        return 100.0
    if s1 in s2 or s2 in s1:
        return 80.0
    seq_ratio  = difflib.SequenceMatcher(None, s1, s2).ratio() * 100
    words1     = set(re.findall(r'\w+', s1))
    words2     = set(re.findall(r'\w+', s2))
    word_ratio = (len(words1 & words2) / max(len(words1), len(words2)) * 100) if (words1 and words2) else 0.0
    return max(seq_ratio, word_ratio)


def select_best_match(places, expected_city, expected_state=None,
                      expected_issuer=None, expected_location=None, expected_address=None):
    &quot;&quot;&quot;
    Multi-criteria scoring:
      City match      100 pts  (critical)
      State match      50 pts
      Issuer sim       40 pts
      Location sim     40 pts
      Address sim      30 pts
      Position penalty  -5 pts each
    &quot;&quot;&quot;
    if not places:
        return None, None
    if len(places) == 1:
        return places[0], 1

    exp_city  = expected_city.lower().strip()    if expected_city     else &quot;&quot;
    exp_state = expected_state.lower().strip()   if expected_state    else &quot;&quot;
    exp_iss   = expected_issuer.strip()          if expected_issuer   else &quot;&quot;
    exp_loc   = expected_location.strip()        if expected_location else &quot;&quot;
    exp_addr  = expected_address.strip()         if expected_address  else &quot;&quot;

    if SHOW_DETAILED_SELECTION:
        print(f&quot;
   🔍 Analyzing {len(places)} results&quot;)
        print(f&quot;      City: '{expected_city}'&quot;)
        if exp_iss:  print(f&quot;      Issuer: '{exp_iss[:40]}'&quot;)
        if exp_loc:  print(f&quot;      Location: '{exp_loc[:40]}'&quot;)

    scored = []
    for idx, place in enumerate(places):
        found_addr   = place.get('formattedAddress', '')
        found_disp   = place.get('displayName', {}).get('text', '') \
                       if isinstance(place.get('displayName'), dict) else ''
        found_lower  = found_addr.lower()
        score        = 0
        details      = []

        # City
        city_match = bool(re.search(r'\b' + re.escape(exp_city) + r'\b', found_lower)) if exp_city else False
        score     += 100 if city_match else 0
        details.append(&quot;✓City&quot; if city_match else &quot;✗City&quot;)

        # State
        if exp_state and re.search(r'\b' + re.escape(exp_state) + r'\b', found_lower):
            score += 50
            details.append(&quot;✓State&quot;)

        # Issuer
        if exp_iss:
            sim    = max(calculate_similarity(exp_iss, found_disp), calculate_similarity(exp_iss, found_addr))
            score += (sim / 100) * 40
            details.append(f&quot;{'✓' if sim >= 60 else '~'}Issuer({sim:.0f}%)&quot;)

        # Location
        if exp_loc:
            sim    = max(calculate_similarity(exp_loc, found_disp), calculate_similarity(exp_loc, found_addr))
            score += (sim / 100) * 40
            details.append(f&quot;{'✓' if sim >= 60 else '~'}Loc({sim:.0f}%)&quot;)

        # Address
        if exp_addr:
            sim    = calculate_similarity(exp_addr, found_addr)
            score += (sim / 100) * 30
            details.append(f&quot;{'✓' if sim >= 60 else '~'}Addr({sim:.0f}%)&quot;)

        # Position penalty
        score -= idx * 5

        scored.append({'score': score, 'index': idx, 'place': place,
                       'address': found_addr, 'display': found_disp,
                       'details': ', '.join(details), 'city_match': city_match})

        if SHOW_DETAILED_SELECTION:
            print(f&quot;
      {'✅' if city_match else '❌'} Result {idx+1} [Score: {score:.1f}]&quot;)
            if found_disp: print(f&quot;         Name: {found_disp[:55]}&quot;)
            print(f&quot;         Addr: {found_addr[:60]}&quot;)
            print(f&quot;         {', '.join(details)}&quot;)

    scored.sort(key=lambda x: x['score'], reverse=True)
    best = scored[0]

    if SHOW_DETAILED_SELECTION:
        print(f&quot;
   ✅ SELECTED Result {best['index']+1}&quot;)
        print(f&quot;      Score: {best['score']:.1f} | {best['details']}&quot;)
        print(f&quot;      {best['address'][:65]}&quot;)

    return best['place'], best['index'] + 1


# ─────────────────────────────────────────────────────────
# 1C. MATCH TYPE & ACCURACY LABELS
# ─────────────────────────────────────────────────────────

def get_match_type_description(confidence):
    if confidence >= 90: return &quot;Exact Match&quot;
    elif confidence >= 75: return &quot;High Confidence&quot;
    elif confidence >= 60: return &quot;Good Match&quot;
    elif confidence >= 50: return &quot;Moderate Match&quot;
    elif confidence >= 20: return &quot;Low Confidence&quot;
    else: return &quot;Very Low&quot;


def get_places_accuracy_label(place):
    &quot;&quot;&quot;Infer accuracy label from Places API result address structure.&quot;&quot;&quot;
    address = place.get('formattedAddress', '').lower()
    if re.search(r'\b\d+\b', address.split(',')[0]):
        return &quot;ROOFTOP&quot;
    elif any(kw in address for kw in [' st ', ' ave ', ' rd ', ' blvd ', ' ln ', ' dr ', ' way ']):
        return &quot;RANGE_INTERPOLATED&quot;
    elif place.get('displayName'):
        return &quot;GEOMETRIC_CENTER&quot;
    else:
        return &quot;APPROXIMATE&quot;


# ─────────────────────────────────────────────────────────
# 1D. API CALLS
# ─────────────────────────────────────────────────────────

def search_google_places(query):
    &quot;&quot;&quot;Google Places API — returns all results.&quot;&quot;&quot;
    headers = {
        &quot;Content-Type&quot;: &quot;application/json&quot;,
        &quot;X-Goog-Api-Key&quot;: GOOGLE_API_KEY,
        &quot;X-Goog-FieldMask&quot;: &quot;places.displayName,places.formattedAddress,places.location,places.types&quot;
    }
    try:
        response = requests.post(SEARCH_URL, headers=headers,
                                 json={&quot;textQuery&quot;: query}, timeout=15)
        if response.status_code == 200:
            return response.json().get('places', [])
        elif response.status_code == 429:
            print(&quot;⚠️ Rate limit (Places) - waiting...&quot;)
            time.sleep(2)
            return []
        else:
            print(f&quot;⚠️ Places API Error {response.status_code}&quot;)
            return []
    except Exception as e:
        print(f&quot;⚠️ Places request error: {str(e)[:50]}&quot;)
        return []


def search_geocode_api(query):
    &quot;&quot;&quot;
    Google Maps Geocoding API fallback.
    Returns dict: found_addr, lat, lng, location_type, status
    location_type: ROOFTOP | RANGE_INTERPOLATED | GEOMETRIC_CENTER | APPROXIMATE
    &quot;&quot;&quot;
    params = {&quot;address&quot;: query, &quot;key&quot;: GOOGLE_API_KEY}
    try:
        response = requests.get(GEOCODE_URL, params=params, timeout=15)
        if response.status_code == 200:
            data       = response.json()
            api_status = data.get('status', '')
            if api_status == 'OK' and data.get('results'):
                result        = data['results'][0]
                found_addr    = result.get('formatted_address', '')
                lat           = result['geometry']['location'].get('lat')
                lng           = result['geometry']['location'].get('lng')
                location_type = result['geometry'].get('location_type', 'UNKNOWN')
                return {'found_addr': found_addr, 'lat': lat, 'lng': lng,
                        'location_type': location_type, 'status': 'OK'}
            elif api_status == 'ZERO_RESULTS':
                return {'status': 'ZERO_RESULTS'}
            elif api_status == 'OVER_QUERY_LIMIT':
                print(&quot;⚠️ Geocode API quota exceeded - waiting...&quot;)
                time.sleep(3)
                return {'status': 'QUOTA'}
            else:
                return {'status': api_status}
        elif response.status_code == 429:
            print(&quot;⚠️ Rate limit (Geocode) - waiting...&quot;)
            time.sleep(2)
            return {'status': 'RATE_LIMIT'}
        else:
            return {'status': f'HTTP_{response.status_code}'}
    except Exception as e:
        print(f&quot;⚠️ Geocode request error: {str(e)[:50]}&quot;)
        return {'status': 'ERROR'}


# ─────────────────────────────────────────────────────────
# 1E. ROW PROCESSOR
# ─────────────────────────────────────────────────────────

def process_row_intelligent(row, selected_rank):
    &quot;&quot;&quot;
    Process one row:
      Step 1 → Google Places API
      Step 2 → Geocode API fallback if Places returns nothing
    &quot;&quot;&quot;
    # --- NEW AUTO-DETECT LOGIC ---
    if selected_rank == &quot;Auto&quot;:
        addr = str(row.get('LOCATION_ADDRESS', '')).strip()
        # If address is not null, has > 5 characters, and contains at least one number (like a building/street number)
        if addr.lower() not in ['nan', 'none', ''] and len(addr) > 5 and any(c.isdigit() for c in addr):
            actual_rank = &quot;Rank 04&quot;  # Complete address
        else:
            actual_rank = &quot;Rank 02&quot;  # Vague location
    else:
        actual_rank = selected_rank

    # Use the evaluated rank to build the query
    query = build_intelligent_query(row, actual_rank)

    if not query:
        return (&quot;Skipped (Empty Query)&quot;, None, None, 0,
                &quot;No Data&quot;, 0, &quot;SKIPPED&quot;, &quot;N/A&quot;, &quot;N/A&quot;, None, &quot;&quot;) # Added empty string

    expected_city     = str(row.get('CITY',             '')).strip()
    expected_state    = str(row.get('STATE',            '')).strip()
    expected_issuer   = str(row.get('ISSUER_NAME',      '')).strip()
    expected_location = str(row.get('LOCATION_NAME',    '')).strip()
    expected_address  = str(row.get('LOCATION_ADDRESS', '')).strip()

    time.sleep(RATE_LIMIT_DELAY)

    # ── STEP 1: Google Places API ─────────────────────────
    places = search_google_places(query)

    if places:
        # NOTE: Make sure to change 'selected_rank' to 'actual_rank' here!
        if actual_rank == &quot;Rank 04&quot;:
            best_place   = places[0]
            result_rank  = 1
            found_addr   = best_place.get('formattedAddress', '')
            lat          = best_place.get('location', {}).get('latitude')
            lng          = best_place.get('location', {}).get('longitude')
            found_lower  = found_addr.lower()
            city_ok      = expected_city.lower()  in found_lower if expected_city  else False
            state_ok     = expected_state.lower() in found_lower if expected_state else False

            if expected_address:
                confidence = calculate_similarity(expected_address, found_addr)
                if city_ok:  confidence = min(100.0, confidence + 10.0)
                if state_ok: confidence = min(100.0, confidence + 5.0)
                if expected_city and not city_ok:
                    confidence *= 0.6
            else:
                confidence = 70.0 if (city_ok and state_ok) else \
                             50.0 if city_ok else \
                             35.0 if state_ok else 20.0

            confidence       = round(confidence, 2)
            
            # Use raw API component types for Places
            types_array      = best_place.get('types', [])
            geocode_accuracy = &quot;, &quot;.join(types_array) if types_array else &quot;UNKNOWN&quot;
            
            return (found_addr, lat, lng, confidence,
                get_match_type_description(confidence),
                len(places), &quot;SUCCESS&quot;, &quot;Places API&quot;, geocode_accuracy, result_rank, query) # Added query

        # Ranks 01–03: multi-criteria matching
        best_place, result_rank = select_best_match(
            places,
            expected_city=expected_city, expected_state=expected_state,
            expected_issuer=expected_issuer, expected_location=expected_location,
            expected_address=expected_address
        )

        if best_place:
            found_addr   = best_place.get('formattedAddress', '')
            lat          = best_place.get('location', {}).get('latitude')
            lng          = best_place.get('location', {}).get('longitude')
            found_lower  = found_addr.lower()
            components   = [v for v in [expected_location, expected_issuer, expected_city] if v]
            input_cmp    = &quot; &quot;.join(components).strip().lower()
            base_conf    = difflib.SequenceMatcher(None, input_cmp, found_lower).ratio() * 100
            city_ok      = expected_city.lower() in found_lower if expected_city else True
            confidence   = round(base_conf * (1.0 if city_ok else 0.25), 2)
            
            # Use raw API component types for Places
            types_array      = best_place.get('types', [])
            geocode_accuracy = &quot;, &quot;.join(types_array) if types_array else &quot;UNKNOWN&quot;

            return (found_addr, lat, lng, confidence,
                get_match_type_description(confidence),
                len(places), &quot;SUCCESS&quot;, &quot;Places API&quot;, geocode_accuracy, result_rank, query) # Added query

    # ── STEP 2: Geocode API Fallback ──────────────────────
    print(f&quot;
   🔄 Places API → no results → Geocode API fallback&quot;)
    fallback_query = build_geocode_fallback_query(row)

    if not fallback_query:
        return (&quot;Not Found&quot;, None, None, 0, &quot;No Results&quot;, 0, &quot;NOT_FOUND&quot;, &quot;N/A&quot;, &quot;N/A&quot;, None)

    time.sleep(RATE_LIMIT_DELAY)
    geo = search_geocode_api(fallback_query)

    if geo.get('status') != 'OK':
        return (&quot;Not Found&quot;, None, None, 0, &quot;No Results&quot;, 0, &quot;NOT_FOUND&quot;, &quot;N/A&quot;, &quot;N/A&quot;, None)

    found_addr    = geo['found_addr']
    lat           = geo['lat']
    lng           = geo['lng']
    location_type = geo['location_type'] # This is ROOFTOP, RANGE_INTERPOLATED, etc.
    found_lower   = found_addr.lower()
    city_ok       = expected_city.lower() in found_lower if expected_city else True

    lt_conf = {&quot;ROOFTOP&quot;: 95.0, &quot;RANGE_INTERPOLATED&quot;: 75.0,
               &quot;GEOMETRIC_CENTER&quot;: 60.0, &quot;APPROXIMATE&quot;: 40.0}
    confidence = round(lt_conf.get(location_type, 30.0) * (1.0 if city_ok else 0.6), 2)

    return (found_addr, lat, lng, confidence,
            get_match_type_description(confidence),
            1, &quot;SUCCESS&quot;, &quot;Geocode API&quot;, location_type, 1, query) # Fallback is always rank 1
            


# ─────────────────────────────────────────────────────────
# 1F. CHECKPOINT HELPERS
# ─────────────────────────────────────────────────────────

def save_checkpoint(processed_indices, checkpoint_file=CHECKPOINT_FILE):
    data = {'timestamp': datetime.now().isoformat(),
            'processed_indices': list(processed_indices),
            'count': len(processed_indices)}
    try:
        os.makedirs(os.path.dirname(checkpoint_file), exist_ok=True)
        with open(checkpoint_file, 'w') as f:
            json.dump(data, f, indent=2)
        print(f&quot;💾 Checkpoint: {len(processed_indices)} records&quot;)
    except Exception as e:
        print(f&quot;⚠️ Checkpoint error: {e}&quot;)


def load_checkpoint(checkpoint_file=CHECKPOINT_FILE):
    if not os.path.exists(checkpoint_file):
        return set()
    try:
        with open(checkpoint_file, 'r') as f:
            data = json.load(f)
        processed = set(data.get('processed_indices', []))
        if processed:
            print(f&quot;📂 Resuming: {len(processed)} records already done&quot;)
        return processed
    except Exception:
        return set()


def clear_checkpoint(checkpoint_file=CHECKPOINT_FILE):
    try:
        if os.path.exists(checkpoint_file):
            os.remove(checkpoint_file)
    except Exception:
        pass


def save_intermediate_results(df, results_map, output_path):
    try:
        for idx, res_data in results_map.items():
            for col, val in res_data.items():
                df.at[idx, col] = val
        df.to_excel(output_path, index=False)
        print(f&quot;💾 Saved: {output_path}&quot;)
    except Exception as e:
        print(f&quot;⚠️ Save error: {e}&quot;)


# ─────────────────────────────────────────────────────────
# 1G. MAIN GEOCODE RUNNER
# ─────────────────────────────────────────────────────────

def run(input_file, rank_mode=&quot;Rank 01&quot;):
    &quot;&quot;&quot;Process all records — Places API with Geocode API fallback.&quot;&quot;&quot;

    if not os.path.exists(input_file):
        print(f&quot;❌ Input file not found: {input_file}&quot;)
        return

    print(&quot;
&quot; + &quot;=&quot; * 70)
    print(f&quot;FORWARD GEOCODING — {rank_mode.upper()} MODE&quot;)
    print(&quot;=&quot; * 70)

    df            = pd.read_excel(input_file)
    total_records = len(df)
    print(f&quot;📖 Loaded: {total_records} rows&quot;)
    print(f&quot;⚙️  Strategy: {rank_mode}&quot;)
    print(f&quot;🌐 API Flow: Google Places API → Geocode API (fallback)&quot;)

    # Initialise columns
    for col in [COL_FOUND_ADDR_S, COL_MATCH_TYPE, 'MATCH_RANK',
                COL_PROCESSING_STATUS, COL_SOURCE_API, COL_GEOCODE_ACCURACY]:
        if col not in df.columns: df[col] = None
        df[col] = df[col].astype('object')

    for col in [COL_LAT_P, COL_LON_Q, COL_CONFIDENCE, COL_RESULTS_COUNT, COL_RESULT_RANK]:
        if col not in df.columns: df[col] = None
        # Safely convert to numeric; invalid parsing (like 'New') will be set to NaN
        df[col] = pd.to_numeric(df[col], errors='coerce')

    already_processed = load_checkpoint()
    rows_to_process   = [(i, r) for i, r in df.iterrows() if i not in already_processed]
    total_to_process  = len(rows_to_process)

    if total_to_process == 0:
        print(&quot;✅ All records already processed (from checkpoint)&quot;)
        output_path = os.path.join(DIR_GEOCODE, &quot;step1_forward_out.xlsx&quot;)
        df.to_excel(output_path, index=False)
        clear_checkpoint()
        return

    print(f&quot;🎯 Processing ALL {total_to_process} records...&quot;)
    if already_processed:
        print(f&quot;   (Resuming: {len(already_processed)} already done)&quot;)
    print(f&quot;📝 Detailed output for first 3 records...
&quot;)

    build_intelligent_query.debug_count = 0

    results_map        = {}
    processed_count    = 0
    success_count      = 0
    not_found_count    = 0
    multi_result_count = 0
    places_api_count   = 0
    geocode_api_count  = 0

    MAX_WORKERS = 5
    start_time  = time.time()

    global SHOW_DETAILED_SELECTION

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            future_to_idx = {
                executor.submit(process_row_intelligent, row, rank_mode): idx
                for idx, row in rows_to_process
            }

            for future in concurrent.futures.as_completed(future_to_idx):
                idx = future_to_idx[future]
                if processed_count >= 3:
                    SHOW_DETAILED_SELECTION = False

                try:
                    (found_addr, lat, lng, conf, m_type,
                     count, status, source_api, geo_acc, res_rank, query_sent) = future.result()

                    results_map[idx] = {
                        COL_FOUND_ADDR_S:      found_addr,
                        COL_LAT_P:             lat,
                        COL_LON_Q:             lng,
                        COL_CONFIDENCE:        conf,
                        COL_MATCH_TYPE:        m_type,
                        COL_RESULTS_COUNT:     count,
                        'MATCH_RANK':          rank_mode,
                        COL_PROCESSING_STATUS: status,
                        COL_SOURCE_API:        source_api,
                        COL_GEOCODE_ACCURACY:  geo_acc,
                        COL_RESULT_RANK:       res_rank,
                        COL_QUERY_SENT:        query_sent
                    }

                    already_processed.add(idx)
                    processed_count += 1

                    if status == &quot;SUCCESS&quot;:
                        success_count += 1
                        if count > 1:          multi_result_count += 1
                        if source_api == &quot;Places API&quot;:  places_api_count += 1
                        elif source_api == &quot;Geocode API&quot;: geocode_api_count += 1
                    elif status == &quot;NOT_FOUND&quot;:
                        not_found_count += 1

                    if processed_count % 5 == 0 or processed_count == total_to_process:
                        elapsed = time.time() - start_time
                        rate    = processed_count / elapsed if elapsed > 0 else 0
                        eta     = (total_to_process - processed_count) / rate if rate > 0 else 0
                        print(f&quot;
[{processed_count}/{total_to_process}] &quot;
                              f&quot;✓{success_count} ✗{not_found_count} | &quot;
                              f&quot;Places:{places_api_count} Geocode:{geocode_api_count} | &quot;
                              f&quot;{rate:.1f}/s | ETA: {eta:.0f}s&quot;)

                    if processed_count % CHECKPOINT_INTERVAL == 0:
                        save_checkpoint(already_processed)
                        out = os.path.join(DIR_GEOCODE, &quot;step1_forward_out.xlsx&quot;)
                        save_intermediate_results(df, results_map, out)

                except Exception as e:
                    print(f&quot;❌ Error row {idx}: {e}&quot;)
                    already_processed.add(idx)
                    results_map[idx] = {
                        COL_FOUND_ADDR_S:      f&quot;Error: {str(e)[:50]}&quot;,
                        COL_LAT_P:             None, 
                        COL_LON_Q:             None,
                        COL_CONFIDENCE:        0,    
                        COL_MATCH_TYPE:        &quot;Error&quot;,
                        COL_RESULTS_COUNT:     0,    
                        'MATCH_RANK':          rank_mode,
                        COL_PROCESSING_STATUS: &quot;ERROR&quot;,
                        COL_SOURCE_API:        &quot;N/A&quot;,
                        COL_GEOCODE_ACCURACY:  &quot;N/A&quot;,
                        COL_QUERY_SENT:        &quot;&quot; # Add this line to fix the unpack error
                    }

    except KeyboardInterrupt:
        print(&quot;
⚠️ Interrupted!&quot;)
        save_checkpoint(already_processed)
        out = os.path.join(DIR_GEOCODE, &quot;step1_forward_out_PARTIAL.xlsx&quot;)
        save_intermediate_results(df, results_map, out)
        return

    print(&quot;
💾 Saving final results...&quot;)
    for idx, res_data in results_map.items():
        for col, val in res_data.items():
            df.at[idx, col] = val

    os.makedirs(DIR_GEOCODE, exist_ok=True)
    output_path = os.path.join(DIR_GEOCODE, &quot;step1_forward_out.xlsx&quot;)
    df.to_excel(output_path, index=False)
    clear_checkpoint()

    elapsed      = time.time() - start_time
    success_rate = (100 * success_count / processed_count) if processed_count > 0 else 0

    print(&quot;
&quot; + &quot;=&quot; * 70)
    print(&quot;FORWARD GEOCODING COMPLETE&quot;)
    print(&quot;=&quot; * 70)
    print(f&quot;✓ Total Processed   : {processed_count}&quot;)
    print(f&quot;✓ Success           : {success_count} ({success_rate:.1f}%)&quot;)
    print(f&quot;✗ Not Found         : {not_found_count}&quot;)
    print(f&quot;📍 Via Places API   : {places_api_count}&quot;)
    print(f&quot;📍 Via Geocode API  : {geocode_api_count}  (fallback)&quot;)
    print(f&quot;⏱️  Time             : {elapsed:.1f}s ({processed_count/elapsed:.1f} rec/s)&quot;)
    print(f&quot;💾 Output           : {output_path}&quot;)
    print(&quot;=&quot; * 70)

    print(f&quot;
[GUI_UPDATE] Forward: Found={success_count}&quot;)
    print(f&quot;[Summary] Forward: Success={success_count}, Not Found={not_found_count}, &quot;
          f&quot;Rate={success_rate:.1f}%, PlacesAPI={places_api_count}, GeocodeAPI={geocode_api_count}&quot;)


# =========================================================
# SECTION 2 — BUILDING CLASSIFICATION
# =========================================================

def classify_building_data(input_path, output_path):
    &quot;&quot;&quot;Classify each record as Shared or Exclusive based on address keywords.&quot;&quot;&quot;

    df = pd.read_excel(input_path)

    # ─────────────────────────────────────────────────────
    # KEYWORD PATTERNS — original set preserved exactly
    # ─────────────────────────────────────────────────────
    SHARED_PATTERNS = [
        # Units / Suites
        r'\bsuite\b', r'\bunit\b', r'\broom\b', r'\bapt\b', r'\bapartment\b',
        r'\bdept\b', r'\bste\b', r'\brm\b', r'\boffice\b', r'\bpiso\b',
        r'\bflat\b', r'\bsub\b', r'#\d+',

        # Numeric unit patterns
        r'\b\d+/\d+\b',

        # Floors
        r'\bfloor\b', r'\blevel\b', r'\blvl\b', r'\bfl\b', r'\d+[fF]\b',
        r'\d+/[fF]\b', r'\b[fF]l\.\s*\d+', r'\b[fF]loor\s*\d+', r'\b[lL]evel\s*\d+',

        # Multi-tenant / complex structures
        r'\btower\b', r'\bblock\b', r'\bwing\b', r'\bbldg\b', r'\bbuilding\b',
        r'\batrium\b', r'\bplaza\b', r'\bcomplex\b',
        r'\bedificio\b', r'\btorre\b', r'\bannex\b', r'\bpavilion\b', r'\bpodium\b',
        r'\bmall\b', r'\bhub\b',

        # Commercial / Industrial zones
        r'\bindustrial\s+estate\b', r'\bbusiness\s+park\b', r'\btech\s+park\b',
        r'\bscience\s+park\b', r'\bzone\b',

        # Specific commercial spaces
        r'\bdock\b', r'\bwarehouse\b', r'\bwhse\b',
        r'\bkiosk\b', r'\bstall\b', r'\bbooth\b',
        r'\bterminal\b', r'\bdepot\b', r'\bconcourse\b', r'\bhangar\b',

        # ── Multi-language additions ──────────────────────
        # Spanish
        r'\bplanta\b', r'\bdespacho\b', r'\boficina\b', r'\blocal\b',
        # French
        r'\btour\b', r'\b[ée]tage\b', r'\bbureau\b', r'\bbatiment\b',
        r'\bimmeuble\b', r'\bappartement\b', r'\bpavillon\b',
        # German
        r'\bgebäude\b', r'\bgebaeude\b', r'\bturm\b', r'\betage\b',
        r'\bbüro\b', r'\bbuero\b', r'\bhalle\b', r'\beinheit\b',
        # Portuguese
        r'\bedifício\b', r'\bsala\b', r'\bconjunto\b', r'\bandar\b', r'\bloja\b',
        # Italian
        r'\bpalazzo\b', r'\bpiano\b', r'\bscala\b', r'\binterno\b', r'\bfabbricato\b',
        # Dutch
        r'\bgebouw\b', r'\bverdieping\b', r'\beenheid\b',
        # Arabic (transliteration)
        r'\bburj\b', r'\bmabnaa\b', r'\bwahda\b',
        # Chinese (pinyin)
        r'\bdasha\b', r'\bzhongxin\b',
        # Korean / Japanese (romaji)
        r'\bdong\b', r'\bkan\b', r'\bgokan\b',
    ]

    # False-positive exclusion terms — original preserved + common additions
    EXCLUSION_TERMS = [
        'mossel bay', 'bay area', 'bay city',
        'port elizabeth', 'port louis', 'port harcourt', 'port vila',
        'palm beach', 'long beach', 'virginia beach', 'newport beach',
        'market street', 'market place', 'market rd', 'market road',
        'station road', 'station street', 'station avenue',
        'centre street', 'center street',
        'mall road', 'mall street',
        'gate road', 'gate street',
        'block island',
        'torre del lago', 'torre annunziata',
        'bureau of',
        'tour de france',
    ]

    def get_shared_keyword(address):
        &quot;&quot;&quot;Returns first matching keyword string, or None if no match.&quot;&quot;&quot;
        if pd.isna(address):
            return None

        addr_str   = str(address).strip()
        addr_lower = addr_str.lower()

        # Exclusion check — original logic preserved
        for exclusion in EXCLUSION_TERMS:
            if exclusion in addr_lower:
                return None

        matches = []
        for pattern in SHARED_PATTERNS:
            match = re.search(pattern, addr_lower)
            if match:
                matches.append((match.start(), match.group()))

        if matches:
            matches.sort()
            return matches[0][1]

        return None

    # Apply — identical output columns as original
    df['Shared_Keyword_Match']   = df['LOCATION_ADDRESS'].apply(get_shared_keyword)
    df['Building_Classification'] = df['Shared_Keyword_Match'].apply(
        lambda x: 'Shared' if x is not None else 'Exclusive'
    )

    # Summary
    total     = len(df)
    shared    = (df['Building_Classification'] == 'Shared').sum()
    exclusive = (df['Building_Classification'] == 'Exclusive').sum()

    print(&quot;
&quot; + &quot;=&quot; * 60)
    print(&quot;BUILDING CLASSIFICATION — SUMMARY&quot;)
    print(&quot;=&quot; * 60)
    print(f&quot;  Total Records : {total}&quot;)
    print(f&quot;  Shared        : {shared}  ({100*shared/total:.1f}%)&quot;)
    print(f&quot;  Exclusive     : {exclusive}  ({100*exclusive/total:.1f}%)&quot;)
    print(f&quot;  Output        : {output_path}&quot;)
    print(&quot;=&quot; * 60)

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    df.to_excel(output_path, index=False)
    print(f&quot;Update complete. File saved to: {output_path}&quot;)


# =========================================================
# SECTION 3 — PROXIMITY FLAGGING
# =========================================================

def flag_close_proximity(file_path, output_path):
    &quot;&quot;&quot;Flag location pairs within the same Issuer that are within 300m.&quot;&quot;&quot;

    # 1. Load — original logic preserved
    df = pd.read_excel(file_path)

    # Column indices — original preserved exactly
    loc_id_col = df.columns[2]   # Column C (LOCATION_ID)
    issuer_col = df.columns[4]   # Column E (ISSUER_NAME)
    lat_col    = df.columns[15]  # Column P (LATITUDE)
    long_col   = df.columns[16]  # Column Q (LONGITUDE)

    # Output columns — original preserved
    df['Proximity_Flag']  = &quot;&quot;
    df['Distance_Notes']  = &quot;&quot;

    # 2. Group by Issuer — original logic preserved
    grouped = df.groupby(issuer_col)

    for name, group in grouped:
        if len(group) < 2:
            continue

        indices = group.index.tolist()

        # 3. Compare pairs — original logic preserved
        for i, j in combinations(indices, 2):
            lat1  = df.at[i, lat_col]
            lon1  = df.at[i, long_col]
            lat2  = df.at[j, lat_col]
            lon2  = df.at[j, long_col]

            # Skip missing data — original behaviour preserved
            if pd.isna(lat1) or pd.isna(lon1) or pd.isna(lat2) or pd.isna(lon2):
                continue

            coord1 = (lat1, lon1)
            coord2 = (lat2, lon2)

            try:
                dist = geodesic(coord1, coord2).meters

                if dist <= 300:
                    id_i = df.at[i, loc_id_col]
                    id_j = df.at[j, loc_id_col]

                    df.at[i, 'Proximity_Flag'] = 'FLAGGED'
                    df.at[j, 'Proximity_Flag'] = 'FLAGGED'

                    # Append notes — original logic preserved
                    df.at[i, 'Distance_Notes'] = (
                        str(df.at[i, 'Distance_Notes']) + f&quot;Close to {id_j} ({dist:.1f}m); &quot;
                    )
                    df.at[j, 'Distance_Notes'] = (
                        str(df.at[j, 'Distance_Notes']) + f&quot;Close to {id_i} ({dist:.1f}m); &quot;
                    )

            except Exception as e:
                print(f&quot;Error calculating distance for rows {i} and {j}: {e}&quot;)

    # 4. Save — original logic preserved
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    df.to_excel(output_path, index=False)
    print(f&quot;Processing complete. Results saved to: {output_path}&quot;)


# =========================================================
# SECTION 4 — PIPELINE ENTRY POINT
# =========================================================
# Flow:
#   Step 1 → Forward Geocoding        input : <user supplied>
#                                      output: DIR_GEOCODE / step1_forward_out.xlsx
#
#   Step 2 → Building Classification   input : step1_forward_out.xlsx  (geocode output)
#                                      output: DIR_GEOCODE / step2_building_classification_<stem>.xlsx
#
#   Step 3 → Proximity Flagging        input : step2_building_classification_<stem>.xlsx
#                                      output: DIR_GEOCODE / step3_proximity_flagging_<stem>.xlsx
#
# All paths are derived dynamically from DIR_GEOCODE — no static paths.
# =========================================================

if __name__ == &quot;__main__&quot;:
    import sys

    # ── Step 1: Forward Geocoding ──────────────────────────
    geocode_input = os.path.join(DIR_GEOCODE, &quot;test_input.xlsx&quot;)
    if len(sys.argv) > 1:
        geocode_input = sys.argv[1]
    rank = sys.argv[2] if len(sys.argv) > 2 else &quot;Rank 01&quot;

    if not os.path.exists(geocode_input):
        print(f&quot;❌ Geocode input file not found: {geocode_input}&quot;)
        print(&quot;Usage: python Forward_Geocode.py <input_file.xlsx> [Rank 01|02|03|04]&quot;)
        sys.exit(1)

    run(geocode_input, rank)

    # ── Derive downstream paths from geocode output ────────

    # ── Derive downstream paths from geocode output ────────
    # geocode always writes to: DIR_GEOCODE / step1_forward_out.xlsx
    # stem is derived from the original input filename so all 3 outputs
    # share a traceable naming pattern.
    geocode_input_stem = os.path.splitext(os.path.basename(geocode_input))[0]
    geocode_output     = os.path.join(DIR_GEOCODE, &quot;step1_forward_out.xlsx&quot;)

    if not os.path.exists(geocode_output):
        print(f&quot;❌ Geocode output not found — cannot continue pipeline: {geocode_output}&quot;)
        sys.exit(1)

    # ── Step 2: Building Classification ───────────────────
    # Input  = geocode output (step1_forward_out.xlsx)
    # Output = step2_building_classification_<original_stem>.xlsx
    bc_output = os.path.join(
        DIR_GEOCODE,
        f&quot;step2_building_classification_{geocode_input_stem}.xlsx&quot;
    )

    print(f&quot;
{'=' * 70}&quot;)
    print(f&quot;BUILDING CLASSIFICATION&quot;)
    print(f&quot;  Input  : {geocode_output}&quot;)
    print(f&quot;  Output : {bc_output}&quot;)
    print(f&quot;{'=' * 70}&quot;)

    classify_building_data(geocode_output, bc_output)

    if not os.path.exists(bc_output):
        print(f&quot;❌ Building classification output not found — cannot continue: {bc_output}&quot;)
        sys.exit(1)

    # ── Step 3: Proximity Flagging ─────────────────────────
    # Input  = building classification output (step2_*.xlsx)
    # Output = step3_proximity_flagging_<original_stem>.xlsx
    prox_output = os.path.join(
        DIR_GEOCODE,
        f&quot;step3_proximity_flagging_{geocode_input_stem}.xlsx&quot;
    )

    print(f&quot;
{'=' * 70}&quot;)
    print(f&quot;PROXIMITY FLAGGING&quot;)
    print(f&quot;  Input  : {bc_output}&quot;)
    print(f&quot;  Output : {prox_output}&quot;)
    print(f&quot;{'=' * 70}&quot;)

    flag_close_proximity(bc_output, prox_output)

    # ── Pipeline complete ──────────────────────────────────
    print(f&quot;
{'=' * 70}&quot;)
    print(f&quot;✅  FULL PIPELINE COMPLETE&quot;)
    print(f&quot;{'=' * 70}&quot;)
    print(f&quot;  Step 1 → {geocode_output}&quot;)
    print(f&quot;  Step 2 → {bc_output}&quot;)
    print(f&quot;  Step 3 → {prox_output}&quot;)
    print(f&quot;{'=' * 70}&quot;)
    
        # ========================================================================
        # SUMMARY STATISTICS
        # ========================================================================
        summary_label = tk.Label(
            stats_content,
            text=&quot;═══ SUMMARY ═══&quot;,
            font=(&quot;Segoe UI&quot;, 10, &quot;bold&quot;),
            bg=Colors.BG_PANEL,
            fg=Colors.ACCENT
        )
        summary_label.grid(row=0, column=0, columnspan=2, sticky=&quot;w&quot;, pady=(0, 10))
        
        self.create_stat_display(stats_content, &quot;Total Files:&quot;, self.topo_stats['total'], 1, Colors.ACCENT)
        self.create_stat_display(stats_content, &quot;✓ Valid:&quot;, self.topo_stats['valid'], 2, Colors.SUCCESS)
        self.create_stat_display(stats_content, &quot;✗ Failed:&quot;, self.topo_stats['failed'], 3, Colors.ERROR)
        self.create_stat_display(stats_content, &quot;🔧 Auto-Fixed:&quot;, self.topo_stats['fixed'], 4, Colors.INFO)
        
        # Separator
        ttk.Separator(stats_content, orient='horizontal').grid(
            row=5, column=0, columnspan=1, sticky=&quot;ew&quot;, pady=15
        )
        
        # ========================================================================
        # ERROR BREAKDOWN
        # ========================================================================
        error_label = tk.Label(
            stats_content,
            text=&quot;═══ ERROR BREAKDOWN ═══&quot;,
            font=(&quot;Segoe UI&quot;, 10, &quot;bold&quot;),
            bg=Colors.BG_PANEL,
            fg=Colors.ERROR
        )
        error_label.grid(row=6, column=0, columnspan=2, sticky=&quot;w&quot;, pady=(0, 10))
        
        # Error counters (each check)
        self.create_stat_display(stats_content, &quot;1️ Null/Empty:&quot;, self.topo_stats['null_empty'], 7, &quot;#94a3b8&quot;)
        self.create_stat_display(stats_content, &quot;2️ Invalid Type:&quot;, self.topo_stats['invalid_type'], 8, &quot;#94a3b8&quot;)
        self.create_stat_display(stats_content, &quot;3️ Topology Error:&quot;, self.topo_stats['topology_error'], 9, &quot;#94a3b8&quot;)
        self.create_stat_display(stats_content, &quot;4️ Dup Vertices:&quot;, self.topo_stats['duplicate_vertices'], 10, &quot;#94a3b8&quot;)
        self.create_stat_display(stats_content, &quot;5️ Tiny Area:&quot;, self.topo_stats['tiny_area'], 11, &quot;#94a3b8&quot;)
        self.create_stat_display(stats_content, &quot;6️ Overlaps:&quot;, self.topo_stats['overlap'], 12, &quot;#94a3b8&quot;)
        self.create_stat_display(stats_content, &quot;7️ Coord Range:&quot;, self.topo_stats['coord_range'], 13, &quot;#94a3b8&quot;)
        
        # Additional errors
        ttk.Separator(stats_content, orient='horizontal').grid(
            row=14, column=0, columnspan=2, sticky=&quot;ew&quot;, pady=15
        )
        
        self.create_stat_display(stats_content, &quot;MultiPolygon:&quot;, self.topo_stats['multipolygon'], 15, &quot;#e67e22&quot;)
        self.create_stat_display(stats_content, &quot;Process Errors:&quot;, self.topo_stats['error'], 16, Colors.ERROR)
        
        # Status
        ttk.Separator(stats_content, orient='horizontal').grid(
            row=17, column=0, columnspan=2, sticky=&quot;ew&quot;, pady=15
        )
        
        self.create_stat_display(stats_content, &quot;Status:&quot;, self.topo_stats['status'], 18, Colors.ACCENT)
        
        # Help info
        info_frame = tk.Frame(stats_content, bg=&quot;#fff3cd&quot;, relief=tk.FLAT, bd=1)
        info_frame.grid(row=19, column=0, columnspan=2, sticky=&quot;ew&quot;, pady=(20, 0))
        
        tk.Label(
            info_frame,
            text=&quot;💡 Validation ensures:
&quot;
                &quot;   • Only Polygons (no
&quot;
                &quot;     Point/Line/MultiPoly)
&quot;
                &quot;   • Valid topology
&quot;
                &quot;   • No duplicates
&quot;
                &quot;   • Proper size & coords&quot;,
            font=(&quot;Segoe UI&quot;, 8),
            bg=&quot;#fff3cd&quot;,
            fg=&quot;#856404&quot;,
            justify=tk.LEFT
        ).pack(padx=10, pady=10)

    def build_height_tab_layout(self):
        &quot;&quot;&quot;Build enhanced Height Analysis tab&quot;&quot;&quot;
        container = tk.Frame(self.tab_height, bg=Colors.BG_MAIN)
        container.pack(fill=&quot;both&quot;, expand=True, padx=20, pady=20)
        
        # Top card
        top_card = tk.Frame(container, bg=Colors.BG_PANEL, relief=tk.RAISED, bd=1)
        top_card.pack(fill=&quot;x&quot;, pady=(0, 15))
        
        top_content = tk.Frame(top_card, bg=Colors.BG_PANEL)
        top_content.pack(fill=&quot;x&quot;, padx=25, pady=25)
        
        tk.Label(
            top_content,
            text=&quot;Step 4: Regional Height Analysis&quot;,
            font=(&quot;Segoe UI&quot;, 16, &quot;bold&quot;),
            bg=Colors.BG_PANEL,
            fg=Colors.PRIMARY
        ).pack(anchor=&quot;w&quot;, pady=(0, 15))
        
        # Description
        desc_frame = tk.Frame(top_content, bg=&quot;#e8f4f8&quot;, relief=tk.FLAT, bd=1)
        desc_frame.pack(fill=&quot;x&quot;, pady=(0, 20))
        
        tk.Label(
            desc_frame,
            text=&quot;ℹ️  Calculates building heights using region-specific data:
&quot;
                 &quot;    🇺🇸 USA: USGS 3DEP (0.5m)  🇳🇱 Netherlands: PDOK AHN (0.5m)
&quot;
                 &quot;    🇪🇸 Spain: IDEE (5m)  🌍 Global: Copernicus + ALOS (30m)&quot;,
            font=(&quot;Segoe UI&quot;, 10),
            bg=&quot;#e8f4f8&quot;,
            fg=Colors.TEXT_MAIN,
            justify=tk.LEFT
        ).pack(padx=15, pady=12)
        
        # Run button
        tk.Button(
            top_content,
            text=&quot;▶ RUN HEIGHT ANALYSIS&quot;,
            bg=Colors.SUCCESS,
            fg=Colors.TEXT_WHITE,
            font=(&quot;Segoe UI&quot;, 13, &quot;bold&quot;),
            height=2,
            relief=tk.FLAT,
            cursor=&quot;hand2&quot;,
            command=lambda: self.start_thread(self.run_step_4, self.tab_height)
        ).pack(fill=&quot;x&quot;)
        
        # Progress bar
        self.height_progress_bar = ttk.Progressbar(
            top_content,
            variable=self.height_stats['progress'],
            mode='determinate',
            length=400,
            style=&quot;Success.Horizontal.TProgressbar&quot;
        )
        self.height_progress_bar.pack(fill=&quot;x&quot;, pady=(15, 0))
        
        # Bottom section
        bottom_frame = tk.Frame(container, bg=Colors.BG_MAIN)
        bottom_frame.pack(fill=&quot;both&quot;, expand=True)
        
        # Logs
        logs_card = tk.Frame(bottom_frame, bg=Colors.BG_PANEL, relief=tk.RAISED, bd=1)
        logs_card.pack(side=&quot;left&quot;, fill=&quot;both&quot;, expand=True, padx=(0, 10))
        
        log_header = tk.Frame(logs_card, bg=Colors.SECONDARY)
        log_header.pack(fill=&quot;x&quot;)
        
        tk.Label(
            log_header,
            text=&quot;📋 System Logs&quot;,
            font=(&quot;Segoe UI&quot;, 11, &quot;bold&quot;),
            bg=Colors.SECONDARY,
            fg=Colors.TEXT_WHITE
        ).pack(side=&quot;left&quot;, padx=15, pady=10)
        
        self.height_log_area = scrolledtext.ScrolledText(
            logs_card,
            height=20,
            state='disabled',
            bg=Colors.PRIMARY,
            fg=&quot;#f8fafc&quot;,
            font=(&quot;Consolas&quot;, 9),
            relief=tk.FLAT
        )
        self.height_log_area.pack(fill=&quot;both&quot;, expand=True, padx=2, pady=2)
        
        # Statistics
        stats_card = tk.Frame(bottom_frame, bg=Colors.BG_PANEL, relief=tk.RAISED, bd=1)
        stats_card.config(width=350)
        stats_card.pack_propagate(False)
        stats_card.pack(side=&quot;right&quot;, fill=&quot;y&quot;)

        
        stats_header = tk.Frame(stats_card, bg=Colors.SECONDARY)
        stats_header.pack(fill=&quot;x&quot;)
        
        tk.Label(
            stats_header,
            text=&quot;📊 Live Statistics&quot;,
            font=(&quot;Segoe UI&quot;, 11, &quot;bold&quot;),
            bg=Colors.SECONDARY,
            fg=Colors.TEXT_WHITE
        ).pack(padx=15, pady=10)
        
        stats_content = tk.Frame(stats_card, bg=Colors.BG_PANEL)
        stats_content.pack(fill=&quot;both&quot;, expand=True, padx=20, pady=20)
        
        self.create_stat_display(stats_content, &quot;Total Buildings:&quot;, self.height_stats['total'], 0, Colors.ACCENT)
        self.create_stat_display(stats_content, &quot;Processed:&quot;, self.height_stats['processed'], 1, Colors.INFO)
        self.create_stat_display(stats_content, &quot;Positive Heights:&quot;, self.height_stats['positive'], 2, Colors.SUCCESS)
        self.create_stat_display(stats_content, &quot;Negative/Zero:&quot;, self.height_stats['negative'], 3, Colors.WARNING)
        self.create_stat_display(stats_content, &quot;Failed:&quot;, self.height_stats['failed'], 4, Colors.ERROR)
        
        ttk.Separator(stats_content, orient='horizontal').grid(
            row=5, column=0, columnspan=2, sticky=&quot;ew&quot;, pady=10
        )
        
        tk.Label(
            stats_content,
            text=&quot;By Region:&quot;,
            font=(&quot;Segoe UI&quot;, 10, &quot;bold&quot;),
            bg=Colors.BG_PANEL,
            fg=Colors.TEXT_MAIN
        ).grid(row=6, column=0, columnspan=2, sticky=&quot;w&quot;, pady=(0, 8))
        
        self.create_stat_display(stats_content, &quot;🇺🇸 USGS:&quot;, self.height_stats['usgs'], 7, Colors.INFO)
        self.create_stat_display(stats_content, &quot;🇳🇱 Netherlands:&quot;, self.height_stats['netherlands'], 8, Colors.SUCCESS)
        self.create_stat_display(stats_content, &quot;🇪🇸 Spain:&quot;, self.height_stats['spain'], 9, Colors.WARNING)
        self.create_stat_display(stats_content, &quot;🌍 Global:&quot;, self.height_stats['global'], 10, Colors.ACCENT)
        
        ttk.Separator(stats_content, orient='horizontal').grid(
            row=11, column=0, columnspan=2, sticky=&quot;ew&quot;, pady=10
        )
        
        self.create_stat_display(stats_content, &quot;Status:&quot;, self.height_stats['status'], 12, Colors.ACCENT)
    
    def build_auto_tab(self):
        &quot;&quot;&quot;Build enhanced Automated Pipeline tab&quot;&quot;&quot;
        container = tk.Frame(self.tab_auto, bg=Colors.BG_MAIN)
        container.pack(fill=&quot;both&quot;, expand=True, padx=20, pady=20)
        
        # Warning banner
        banner = tk.Frame(container, bg=&quot;#fff3cd&quot;, relief=tk.RAISED, bd=2)
        banner.pack(fill=&quot;x&quot;, pady=(0, 20))
        
        tk.Label(
            banner,
            text=&quot;⚠️  AUTOMATED FULL PIPELINE EXECUTION&quot;,
            font=(&quot;Segoe UI&quot;, 14, &quot;bold&quot;),
            bg=&quot;#fff3cd&quot;,
            fg=&quot;#856404&quot;
        ).pack(pady=(15, 5))
        
        tk.Label(
            banner,
            text=&quot;This will execute ALL 4 steps sequentially. Estimated time: 1-6 hours depending on dataset size.&quot;,
            font=(&quot;Segoe UI&quot;, 10),
            bg=&quot;#fff3cd&quot;,
            fg=&quot;#856404&quot;
        ).pack(pady=(0, 15))
        
        # File selection
        input_card = tk.Frame(container, bg=Colors.BG_PANEL, relief=tk.RAISED, bd=1)
        input_card.pack(fill=&quot;x&quot;, pady=(0, 20))
        
        input_content = tk.Frame(input_card, bg=Colors.BG_PANEL)
        input_content.pack(fill=&quot;x&quot;, padx=25, pady=25)
        
        tk.Label(
            input_content,
            text=&quot;Select Input Excel File:&quot;,
            font=(&quot;Segoe UI&quot;, 11, &quot;bold&quot;),
            bg=Colors.BG_PANEL
        ).pack(anchor=&quot;w&quot;, pady=(0, 8))
        
        input_frame = tk.Frame(input_content, bg=Colors.BG_PANEL)
        input_frame.pack(fill=&quot;x&quot;, pady=(0, 20))
        
        self.auto_input_var = tk.StringVar()
        tk.Entry(
            input_frame,
            textvariable=self.auto_input_var,
            font=(&quot;Segoe UI&quot;, 11),
            bg=Colors.BG_INPUT,
            relief=tk.FLAT,
            bd=2
        ).pack(side=&quot;left&quot;, fill=&quot;x&quot;, expand=True, padx=(0, 10), ipady=10)
        
        tk.Button(
            input_frame,
            text=&quot;📁 Browse&quot;,
            bg=Colors.ACCENT,
            fg=Colors.TEXT_WHITE,
            font=(&quot;Segoe UI&quot;, 11, &quot;bold&quot;),
            relief=tk.FLAT,
            cursor=&quot;hand2&quot;,
            padx=20,
            command=lambda: self.auto_input_var.set(
                filedialog.askopenfilename(
                    title=&quot;Select Input Excel File&quot;,
                    filetypes=[(&quot;Excel Files&quot;, &quot;*.xlsx&quot;), (&quot;All Files&quot;, &quot;*.*&quot;)]
                )
            )
        ).pack(side=&quot;left&quot;)
        
        # Run button
        tk.Button(
            input_content,
            text=&quot;🚀 START AUTOMATED PIPELINE&quot;,
            bg=Colors.ERROR,
            fg=Colors.TEXT_WHITE,
            font=(&quot;Segoe UI&quot;, 13, &quot;bold&quot;),
            height=2,
            relief=tk.FLAT,
            cursor=&quot;hand2&quot;,
            command=lambda: self.start_thread(self.run_full_pipeline, self.tab_auto)
        ).pack(fill=&quot;x&quot;)
        
        # Pipeline progress
        progress_card = tk.Frame(container, bg=Colors.BG_PANEL, relief=tk.RAISED, bd=1)
        progress_card.pack(fill=&quot;x&quot;, pady=(0, 20))
        
        progress_content = tk.Frame(progress_card, bg=Colors.BG_PANEL)
        progress_content.pack(fill=&quot;both&quot;, expand=True, padx=25, pady=25)
        
        tk.Label(
            progress_content,
            text=&quot;Pipeline Step Progress:&quot;,
            font=(&quot;Segoe UI&quot;, 12, &quot;bold&quot;),
            bg=Colors.BG_PANEL,
            fg=Colors.TEXT_MAIN
        ).pack(anchor=&quot;w&quot;, pady=(0, 15))
        
        steps = [
            (&quot;1. Geocoding&quot;, self.geo_stats['status']),
            (&quot;2. Extraction&quot;, self.poly_stats['status']),
            (&quot;3. Validation&quot;, self.topo_stats['status']),
            (&quot;4. Height Analysis&quot;, self.height_stats['status'])
        ]
        
        for label, var in steps:
            step_frame = tk.Frame(progress_content, bg=Colors.BG_PANEL)
            step_frame.pack(fill=&quot;x&quot;, pady=5)
            
            tk.Label(
                step_frame,
                text=label,
                font=(&quot;Segoe UI&quot;, 10, &quot;bold&quot;),
                bg=Colors.BG_PANEL,
                width=20,
                anchor=&quot;w&quot;
            ).pack(side=&quot;left&quot;)
            
            tk.Label(
                step_frame,
                textvariable=var,
                font=(&quot;Segoe UI&quot;, 10),
                bg=Colors.BG_PANEL,
                fg=Colors.ACCENT,
                anchor=&quot;w&quot;
            ).pack(side=&quot;left&quot;, fill=&quot;x&quot;, expand=True)
        
        # Logs
        logs_card = tk.Frame(container, bg=Colors.BG_PANEL, relief=tk.RAISED, bd=1)
        logs_card.pack(fill=&quot;both&quot;, expand=True)
        
        log_header = tk.Frame(logs_card, bg=Colors.SECONDARY)
        log_header.pack(fill=&quot;x&quot;)
        
        tk.Label(
            log_header,
            text=&quot;📋 Pipeline Execution Logs&quot;,
            font=(&quot;Segoe UI&quot;, 11, &quot;bold&quot;),
            bg=Colors.SECONDARY,
            fg=Colors.TEXT_WHITE
        ).pack(side=&quot;left&quot;, padx=15, pady=10)
        
        self.auto_log_area = scrolledtext.ScrolledText(
            logs_card,
            height=15,
            state='disabled',
            bg=Colors.PRIMARY,
            fg=&quot;#f8fafc&quot;,
            font=(&quot;Consolas&quot;, 9),
            relief=tk.FLAT
        )
        self.auto_log_area.pack(fill=&quot;both&quot;, expand=True, padx=2, pady=2)
    
    # ==================
    # UTILITY METHODS
    # ==================
    
    def create_stat_display(self, parent, label, variable, row, color):
        &quot;&quot;&quot;Create an enhanced statistic display row&quot;&quot;&quot;
        label_widget = tk.Label(
            parent,
            text=label,
            font=(&quot;Segoe UI&quot;, 10, &quot;bold&quot;),
            bg=Colors.BG_PANEL,
            fg=Colors.TEXT_MAIN,
            anchor=&quot;w&quot;
        )
        label_widget.grid(row=row, column=0, sticky=&quot;w&quot;, pady=8, padx=(0, 10))
        
        value_frame = tk.Frame(parent, bg=Colors.BG_INPUT, relief=tk.FLAT, bd=1)
        value_frame.grid(row=row, column=1, sticky=&quot;ew&quot;, pady=8)
        
        value_widget = tk.Label(
            value_frame,
            textvariable=variable,
            font=(&quot;Segoe UI&quot;, 11, &quot;bold&quot;),
            bg=Colors.BG_INPUT,
            fg=color,
            anchor=&quot;center&quot;
        )
        value_widget.pack(padx=10, pady=5)
        
        parent.grid_columnconfigure(1, weight=1)
    
    def clear_logs(self):
        &quot;&quot;&quot;Clear all log windows&quot;&quot;&quot;
        log_widgets = [
            'geo_log_area', 'poly_log_area', 'topo_log_area',
            'height_log_area', 'auto_log_area'
        ]
        for widget_name in log_widgets:
            if hasattr(self, widget_name):
                widget = getattr(self, widget_name)
                widget.config(state='normal')
                widget.delete(1.0, tk.END)
                widget.config(state='disabled')
        
        messagebox.showinfo(&quot;Logs Cleared&quot;, &quot;All system logs have been cleared.&quot;)
    
    def open_output_folder(self):
        &quot;&quot;&quot;Open the project outputs folder&quot;&quot;&quot;
        output_dir = os.path.dirname(config.DIR_GEOCODE)
        if not os.path.exists(output_dir):
            os.makedirs(output_dir, exist_ok=True)
        
        if sys.platform == &quot;win32&quot;:
            os.startfile(output_dir)
        elif sys.platform == &quot;darwin&quot;:
            os.system(f&quot;open '{output_dir}'&quot;)
        else:
            os.system(f&quot;xdg-open '{output_dir}'&quot;)
    
    def open_config_file(self):
        &quot;&quot;&quot;Open config.py in default text editor&quot;&quot;&quot;
        config_path = os.path.join(os.path.dirname(__file__), &quot;config.py&quot;)
        if os.path.exists(config_path):
            if sys.platform == &quot;win32&quot;:
                os.startfile(config_path)
            elif sys.platform == &quot;darwin&quot;:
                os.system(f&quot;open '{config_path}'&quot;)
            else:
                os.system(f&quot;xdg-open '{config_path}'&quot;)
        else:
            messagebox.showerror(&quot;Error&quot;, &quot;config.py not found&quot;)
    
    def log(self, message, level=&quot;INFO&quot;):
        &quot;&quot;&quot;Add message to log queue for thread-safe logging&quot;&quot;&quot;
        timestamp = datetime.now().strftime(&quot;%H:%M:%S&quot;)
        formatted_msg = f&quot;[{timestamp}] [{level}] {message}&quot;
        self.log_queue.put(formatted_msg)
        print(formatted_msg)
    
    def process_log_queue(self):
        &quot;&quot;&quot;Process queued log messages and update UI&quot;&quot;&quot;
        try:
            while not self.log_queue.empty():
                message = self.log_queue.get_nowait()
                
                # Determine which log area to update
                active_tab = self.notebook.index(self.notebook.select())
                log_areas = [
                    self.geo_log_area,
                    self.poly_log_area,
                    self.topo_log_area,
                    self.height_log_area,
                    self.auto_log_area
                ]
                
                if 0 <= active_tab < len(log_areas):
                    log_area = log_areas[active_tab]
                    log_area.config(state='normal')
                    log_area.insert(tk.END, message + &quot;
&quot;)
                    log_area.see(tk.END)
                    log_area.config(state='disabled')
                
                # Parse statistics
                self.parse_statistics(message)
                
        except queue.Empty:
            pass
        finally:
            self.root.after(100, self.process_log_queue)
    
    def parse_statistics(self, message):
            &quot;&quot;&quot;Extract statistics from log messages and update UI&quot;&quot;&quot;
            
            # === 1. GEOCODING STATISTICS (Step 1) ===
            if &quot;Total Records:&quot; in message or &quot;Total Rows:&quot; in message:
                match = re.search(r&quot;(?:Total Records|Total Rows):\s*(\d+)&quot;, message)
                if match:
                    self.geo_stats['total'].set(match.group(1))
            
            # Forward Geocoding - Missing Coordinates
            if &quot;Missing Coordinates:&quot; in message or &quot;Rows Missing Coordinates:&quot; in message:
                match = re.search(r&quot;(?:Missing|Rows Missing) Coordinates:\s*(\d+)&quot;, message)
                if match:
                    self.geo_stats['missing_coords'].set(match.group(1))

            # Reverse Geocoding - Need Reverse Geocoding
            if &quot;Need Reverse Geocoding:&quot; in message:
                match = re.search(r&quot;Need Reverse Geocoding:\s*(\d+)&quot;, message)
                if match:
                    self.geo_stats['missing_addr'].set(match.group(1))
            
            # Forward Geocoding Results - using [GUI_UPDATE] tag
            if &quot;[GUI_UPDATE] Forward: Found=&quot; in message:
                match = re.search(r&quot;\[GUI_UPDATE\] Forward: Found=(\d+)&quot;, message)
                if match:
                    self.geo_stats['filled_fwd'].set(match.group(1))
            
            # Reverse Geocoding Results - using [GUI_UPDATE] tag
            if &quot;[GUI_UPDATE] Reverse: Found=&quot; in message or &quot;[GUI_UPDATE] Addresses Filled:&quot; in message:
                match = re.search(r&quot;\[GUI_UPDATE\].*?(?:Found=|Filled:)\s*(\d+)&quot;, message)
                if match:
                    self.geo_stats['filled_rev'].set(match.group(1))

            # Not Found - using [GUI_UPDATE] tag
            if &quot;[GUI_UPDATE] Not Found:&quot; in message:
                match = re.search(r&quot;\[GUI_UPDATE\] Not Found:\s*(\d+)&quot;, message)
                if match:
                    self.geo_stats['not_found'].set(match.group(1))

            # Total Processed
            if &quot;Total Processed:&quot; in message:
                match = re.search(r&quot;Total Processed:\s*(\d+)&quot;, message)
                if match:
                    if 'processed_count' in self.geo_stats:
                        self.geo_stats['processed_count'].set(match.group(1))
            
            # === 2. POLYGON EXTRACTION STATISTICS (Step 2) ===
            if &quot;Total Locations:&quot; in message:
                match = re.search(r&quot;Total Locations:\s*(\d+)&quot;, message)
                if match:
                    self.poly_stats['total'].set(match.group(1))

            if &quot;Already Processed:&quot; in message:
                match = re.search(r&quot;Already Processed:\s*(\d+)&quot;, message)
                if match:
                    self.poly_stats['processed'].set(match.group(1))
            
            if &quot;MS Found:&quot; in message or &quot;Microsoft Found:&quot; in message:
                match = re.search(r&quot;(?:MS|Microsoft) Found:\s*(\d+)&quot;, message)
                if match:
                    self.poly_stats['ms_found'].set(match.group(1))
            
            if &quot;Google Found:&quot; in message:
                match = re.search(r&quot;Google Found:\s*(\d+)&quot;, message)
                if match:
                    self.poly_stats['google_found'].set(match.group(1))

            # FIXING THE GAP: New Fields for Step 2
            if &quot;Total Buildings Found:&quot; in message:
                match = re.search(r&quot;Total Buildings Found:\s*(\d+)&quot;, message)
                if match:
                    self.poly_stats['buildings_found'].set(match.group(1))

            if &quot;Success Rate:&quot; in message:
                match = re.search(r&quot;Success Rate:\s*([\d.]+\%)&quot;, message)
                if match:
                    self.poly_stats['success_rate'].set(match.group(1))
            
            # === 3. HEIGHT ANALYSIS STATISTICS (Step 4) ===
            if &quot;Total Buildings:&quot; in message:
                match = re.search(r&quot;Total Buildings:\s*(\d+)&quot;, message)
                if match:
                    self.height_stats['total'].set(match.group(1))
            
            if &quot;Successfully Processed:&quot; in message or &quot;Processed:&quot; in message:
                match = re.search(r&quot;(?:Successfully )?Processed:\s*(\d+)&quot;, message)
                if match:
                    self.height_stats['processed'].set(match.group(1))

            # === 3. TOPOLOGY QC STATISTICS (Step 3) ===
            if &quot;Total Files Processed:&quot; in message:
                match = re.search(r&quot;Total Files Processed:\s*(\d+)&quot;, message)
                if match:
                    self.topo_stats['total'].set(match.group(1))

            if &quot;✓ Valid:&quot; in message:
                match = re.search(r&quot;✓ Valid:\s*(\d+)&quot;, message)
                if match:
                    self.topo_stats['valid'].set(match.group(1))

            if &quot;✗ Failed:&quot; in message:
                match = re.search(r&quot;✗ Failed:\s*(\d+)&quot;, message)
                if match:
                    self.topo_stats['failed'].set(match.group(1))

            if &quot;🔧 Auto-Fixed:&quot; in message:
                match = re.search(r&quot;🔧 Auto-Fixed:\s*(\d+)&quot;, message)
                if match:
                    self.topo_stats['fixed'].set(match.group(1))

            # --- Error Breakdown Stage-by-Stage ---
            # Stage 1: Null/Empty
            if &quot;1. Null/Empty:&quot; in message:
                match = re.search(r&quot;1\. Null/Empty:\s*(\d+)&quot;, message)
                if match: self.topo_stats['null_empty'].set(match.group(1))

            # Stage 2: Invalid Type
            if &quot;2. Invalid Type:&quot; in message:
                match = re.search(r&quot;2\. Invalid Type:\s*(\d+)&quot;, message)
                if match: self.topo_stats['invalid_type'].set(match.group(1))

            # Stage 3: Topology Errors
            if &quot;3. Topology Errors:&quot; in message:
                match = re.search(r&quot;3\. Topology Errors:\s*(\d+)&quot;, message)
                if match: self.topo_stats['topology_error'].set(match.group(1))

            # Stage 4: Duplicate Vertices
            if &quot;4. Duplicate Vertices:&quot; in message:
                match = re.search(r&quot;4\. Duplicate Vertices:\s*(\d+)&quot;, message)
                if match: self.topo_stats['duplicate_vertices'].set(match.group(1))

            # Stage 5: Tiny Area
            if &quot;5. Tiny Area:&quot; in message:
                match = re.search(r&quot;5\. Tiny Area:\s*(\d+)&quot;, message)
                if match: self.topo_stats['tiny_area'].set(match.group(1))

            # Stage 6: Overlaps
            if &quot;6. Overlaps:&quot; in message:
                match = re.search(r&quot;6\. Overlaps:\s*(\d+)&quot;, message)
                if match: self.topo_stats['overlap'].set(match.group(1))

            # Stage 7: Coord Range
            if &quot;7. Coord Range:&quot; in message:
                match = re.search(r&quot;7\. Coord Range:\s*(\d+)&quot;, message)
                if match: self.topo_stats['coord_range'].set(match.group(1))

            # Additional Types
            if &quot;MultiPolygon:&quot; in message:
                match = re.search(r&quot;MultiPolygon:\s*(\d+)&quot;, message)
                if match: self.topo_stats['multipolygon'].set(match.group(1))

            if &quot;Processing Errors:&quot; in message:
                match = re.search(r&quot;Processing Errors:\s*(\d+)&quot;, message)
                if match: self.topo_stats['error'].set(match.group(1))
            
            # Trigger progress bar updates
            self.update_progress_indicators()
    
    def update_progress_indicators(self):
        &quot;&quot;&quot;Update progress bars based on current statistics&quot;&quot;&quot;
        try:
            total = int(self.geo_stats['total'].get())
            if total > 0:
                fwd_filled = int(self.geo_stats['filled_fwd'].get())
                rev_filled = int(self.geo_stats['filled_rev'].get())
                progress = int(((fwd_filled + rev_filled) / total) * 100)
                self.geo_stats['progress'].set(min(progress, 100))
                
            # Polygon progress
            total = int(self.poly_stats['total'].get())
            if total > 0:
                ms = int(self.poly_stats['ms_found'].get())
                google = int(self.poly_stats['google_found'].get())
                progress = int(((ms + google) / (total * 2)) * 100)  # *2 for both sources
                self.poly_stats['progress'].set(min(progress, 100))

            # Topology progress logic
            total = int(self.topo_stats['total'].get())
            if total > 0:
                # Calculate progress based on files processed (Valid + Failed)
                processed = int(self.topo_stats['valid'].get()) + int(self.topo_stats['failed'].get())
                progress = int((processed / total) * 100)
                self.topo_stats['progress'].set(min(progress, 100))
            
        except ValueError:
            pass
    
    def update_elapsed_time(self):
        &quot;&quot;&quot;Update elapsed time display&quot;&quot;&quot;
        if self.pipeline_stats['start_time']:
            elapsed = time.time() - self.pipeline_stats['start_time']
            hours = int(elapsed // 3600)
            minutes = int((elapsed % 3600) // 60)
            seconds = int(elapsed % 60)
            self.pipeline_stats['elapsed_time'].set(f&quot;{hours:02d}:{minutes:02d}:{seconds:02d}&quot;)
        
        self.root.after(1000, self.update_elapsed_time)
    
    # ==================
    # WORKFLOW EXECUTION WITH VALIDATION
    # ==================
    
    def start_thread(self, target_function, tab_ref):
        &quot;&quot;&quot;Start a background thread for long-running operations&quot;&quot;&quot;
        if self.is_running:
            messagebox.showwarning(
                &quot;Pipeline Running&quot;,
                &quot;A process is already running. Please wait for it to complete.&quot;
            )
            return
        
        self.is_running = True
        self.pipeline_stats['start_time'] = time.time()
        
        # Determine which input variable to use
        if tab_ref == self.tab_geo:
            file_path = self.geo_input_var.get()
        elif tab_ref == self.tab_poly:
            file_path = self.poly_input_var.get()
        elif tab_ref == self.tab_auto:
            file_path = self.auto_input_var.get()
        else:
            file_path = None
        
        def wrapper():
            &quot;&quot;&quot;Thread wrapper for exception handling&quot;&quot;&quot;
            sys.stdout = StdoutRedirector(self.log_queue)
            
            try:
                target_function(file_path)
                messagebox.showinfo(&quot;Success&quot;, &quot;Process completed successfully!&quot;)
            except Exception as e:
                error_msg = str(e)
                self.log(f&quot;❌ CRITICAL ERROR: {error_msg}&quot;, &quot;ERROR&quot;)
                self.log(traceback.format_exc(), &quot;ERROR&quot;)
                messagebox.showerror(&quot;Error&quot;, f&quot;An error occurred:

{error_msg[:200]}&quot;)
            finally:
                sys.stdout = sys.__stdout__
                self.is_running = False
                self.pipeline_stats['start_time'] = None
        
        threading.Thread(target=wrapper, daemon=True).start()
    
    def _estimate_processing_time(self, num_records):
        &quot;&quot;&quot;Estimate processing time&quot;&quot;&quot;
        seconds = num_records * 2.5
        
        if seconds < 60:
            return f&quot;~{int(seconds)} seconds&quot;
        elif seconds < 3600:
            return f&quot;~{int(seconds/60)} minutes&quot;
        else:
            hours = int(seconds/3600)
            mins = int((seconds % 3600)/60)
            return f&quot;~{hours}h {mins}m&quot;
    
    def run_step_1(self, file_path):
        &quot;&quot;&quot;Execute Step 1: Geocoding with Validation&quot;&quot;&quot;
        if not file_path:
            raise ValueError(&quot;No input file selected&quot;)
        
        if not os.path.exists(file_path):
            raise FileNotFoundError(f&quot;Input file not found: {file_path}&quot;)
        
        self.geo_stats['status'].set(&quot;🔍 Validating...&quot;)
        self.pipeline_stats['current_step'].set(&quot;Step 1: Validation&quot;)
        
        self.log(&quot;=&quot; * 70)
        self.log(&quot;🔍 INPUT VALIDATION & ANALYSIS&quot;)
        self.log(&quot;=&quot; * 70)
        
        if VALIDATION_AVAILABLE:
            try:
                validator = InputValidator(file_path)
                is_valid, report, validated_df = validator.validate()
                
                if not is_valid:
                    error_msg = report.get('error', 'Validation failed')
                    raise ValueError(f&quot;❌ Input validation failed: {error_msg}&quot;)
                
                quality = report['quality']
                
                # 1. Build Header and File Summary
                confirmation_msg = f&quot;&quot;&quot;
╔══════════════════════════════════════════╗
║           DATA VALIDATION COMPLETE       ║
╚══════════════════════════════════════════╝

📊 INPUT FILE SUMMARY:
   • Total Records:           {quality['total_records']}
   • Missing Coordinates:     {quality['missing_coords']} ({quality['pct_missing_coords']:.1f}%)
   • Missing Addresses:       {quality['missing_address']} ({quality['pct_missing_address']:.1f}%)
   • Complete Records:        {quality['complete_records']} ({quality['pct_complete']:.1f}%)

🌍 COUNTRY DISTRIBUTION:&quot;&quot;&quot;
                
                # 2. Build 3-Column Country Grid (Aligned with Monospace)
                countries = sorted(quality['country_distribution'].items(), 
                                  key=lambda x: x[1], reverse=True)
                
                cols = 4
                col_width = 22  # Total width for each column block
                
                for i in range(0, len(countries), cols):
                    row_items = countries[i:i+cols]
                    row_str = &quot;
   &quot;
                    for country, count in row_items:
                        name = str(country).strip()
                        # Truncate to keep column spacing predictable
                        display_name = (name[:12] + '..') if len(name) > 14 else name
                        # Format: Bullet + Name(14 spaces) + Count(3 spaces)
                        item_text = f&quot;• {display_name:<14} ({count:>3})&quot;
                        row_str += f&quot;{item_text:<{col_width}}  &quot;
                    confirmation_msg += row_str

                # 3. Processing Requirements and Time Estimates
                confirmation_msg += f&quot;&quot;&quot;

🔄 PROCESSING REQUIREMENTS:
   • Forward Geocoding:  {'✅ YES - ' + str(quality['missing_coords']) + ' records need coordinates' if report['needs_forward_geocoding'] else '❌ Not needed'}
   • Reverse Geocoding:  {'✅ YES - ' + str(quality['missing_address']) + ' records need addresses' if report['needs_reverse_geocoding'] else '❌ Not needed'}

⏱️  ESTIMATED TIME: {self._estimate_processing_time(quality['total_records'])}

╔══════════════════════════════════════════════╗
║  Would you like to proceed with geocoding?   ║
╚══════════════════════════════════════════════╝
&quot;&quot;&quot;
                
                # 4. Display the custom dialog (waits for user response)
                dialog = MonospaceDialog(self.root, &quot;Confirm Processing&quot;, confirmation_msg)
                self.root.wait_window(dialog)
                proceed = dialog.result
                
                if not proceed:
                    self.log(&quot;❌ Processing cancelled by user&quot;)
                    self.geo_stats['status'].set(&quot;Cancelled&quot;)
                    return
                
                self.log(&quot;✅ Validation passed - User confirmed to proceed&quot;)
                
                # Update UI Statistics with validated data
                self.geo_stats['total'].set(str(quality['total_records']))
                self.geo_stats['missing_coords'].set(str(quality['missing_coords']))
                self.geo_stats['missing_addr'].set(str(quality['missing_address']))
                
                # Save validated data
                validated_path = os.path.join(config.DIR_GEOCODE, &quot;validated_input.xlsx&quot;)
                os.makedirs(config.DIR_GEOCODE, exist_ok=True)
                validated_df.to_excel(validated_path, index=False, engine='openpyxl')
                
                validator.save_report(config.DIR_GEOCODE)
                self.log(f&quot;💾 Validated data saved: validated_input.xlsx&quot;)
                
                # Update file path for the next phases
                file_path = validated_path
                
            except ImportError:
                self.log(&quot;⚠️  Input_Validator module not found - skipping validation&quot;, &quot;WARNING&quot;)
            except Exception as e:
                self.log(f&quot;⚠️  Validation error: {str(e)}&quot;, &quot;WARNING&quot;)
                
                proceed = messagebox.askyesno(
                    &quot;Validation Error&quot;,
                    f&quot;Validation encountered an error:

{str(e)}

&quot;
                    f&quot;Would you like to proceed anyway?

&quot;
                    f&quot;⚠️ This is not recommended - data may not process correctly.&quot;,
                    icon='warning'
                )
                
                if not proceed:
                    self.log(&quot;❌ Processing cancelled due to validation error&quot;)
                    self.geo_stats['status'].set(&quot;Cancelled&quot;)
                    return
        
        # ==========================================
        # GEOCODING EXECUTION
        # ==========================================
        self.log(&quot;=&quot; * 70)
        self.log(&quot;📍 STEP 1: GEOCODING PROCESS STARTED&quot;)
        self.log(&quot;=&quot; * 70)
        
        self.geo_stats['status'].set(&quot;🔄 Running...&quot;)
        self.pipeline_stats['current_step'].set(&quot;Step 1: Geocoding&quot;)
        
        s1_fwd = load_workflow_module(&quot;Forward_Geocode&quot;)
        s1_rev = load_workflow_module(&quot;Geocode&quot;)
        
        if not s1_fwd or not s1_rev:
            raise ImportError(&quot;Could not load geocoding modules&quot;)
        
        self.log(f&quot;📁 Processing file: {os.path.basename(file_path)}&quot;)
        
        # [UPDATED] Get the selected rank from GUI variable
        selected_rank = self.geo_rank_var.get()
        self.log(f&quot;⚙️  Using Strategy: {selected_rank}&quot;)
        
        # Pass the selection to the run function
        s1_fwd.run(file_path, selected_rank)

        # --- NEW CODE: Run Classification & Proximity ---
        forward_out_path = os.path.join(config.DIR_GEOCODE, &quot;step1_forward_out.xlsx&quot;)
        
        self.log(&quot;🏢 Running Building Classification...&quot;)
        s1_fwd.classify_building_data(forward_out_path, forward_out_path)
        
        self.log(&quot;📍 Running Proximity Flagging...&quot;)
        s1_fwd.flag_close_proximity(forward_out_path, forward_out_path)
        # ------------------------------------------------
        
        intermediate = os.path.join(config.DIR_GEOCODE, &quot;step1_forward_out.xlsx&quot;)
        if os.path.exists(intermediate):
            self.log(&quot;🔄 Phase 2: Reverse Geocoding (Coordinates → Address)&quot;)
            s1_rev.run(intermediate)
        else:
            raise FileNotFoundError(&quot;Forward geocoding failed&quot;)
        
        self.geo_stats['status'].set(&quot;✅ Complete&quot;)
        self.geo_stats['progress'].set(100)
        self.pipeline_stats['overall_progress'].set(25)
        
        self.log(&quot;=&quot; * 70)
        self.log(&quot;✅ STEP 1 COMPLETED SUCCESSFULLY&quot;)
        self.log(&quot;=&quot; * 70)
        
        messagebox.showinfo(
            &quot;Geocoding Complete&quot;,
            f&quot;✅ Geocoding completed successfully!

&quot;
            f&quot;Output file: step1_complete.xlsx
&quot;
            f&quot;Location: {config.DIR_GEOCODE}

&quot;
            f&quot;You can now proceed to Step 2: Building Extraction&quot;
        )

    def run_forward_geocoding(self, file_path):
        &quot;&quot;&quot;Execute Forward Geocoding Only (Address → Coordinates) with Validation Dialog&quot;&quot;&quot;
        if not file_path:
            raise ValueError(&quot;No input file selected&quot;)
        
        if not os.path.exists(file_path):
            raise FileNotFoundError(f&quot;Input file not found: {file_path}&quot;)
        
        self.log(&quot;=&quot; * 70)
        self.log(&quot;📍 FORWARD GEOCODING: Address → Coordinates&quot;)
        self.log(&quot;=&quot; * 70)
        
        # Step 1: Validate Input File
        self.log(&quot;
🔍 Step 1: Validating Input File...&quot;)
        self.geo_stats['status'].set(&quot;🔍 Validating...&quot;)
        
        # Load Input Validator
        validator_module = load_workflow_module(&quot;Input_Validator&quot;)
        if not validator_module:
            self.geo_stats['status'].set(&quot;❌ Module Error&quot;)
            raise ImportError(&quot;Could not load Input_Validator module&quot;)
        
        # Run validation logic
        validator = validator_module.InputValidator(file_path)
        is_valid, report, df = validator.validate()
        
        if not is_valid:
            error_msg = report.get('error', 'Validation failed')
            self.geo_stats['status'].set(&quot;❌ Validation Failed&quot;)
            raise ValueError(f&quot;Input validation failed: {error_msg}&quot;)
        
        # Step 2: Show validation dialog and get user confirmation
        self.log(&quot;
📋 Displaying validation results...&quot;)
        
        user_confirmed = False
        quality = report.get('quality', {})
        missing_coords = quality.get('missing_coords', 0)
        total_records = quality.get('total_records', 0)

        # Check if processing is actually needed
        if missing_coords == 0:
            self.log(&quot;
✅ All records already have coordinates!&quot;)
            self.geo_stats['status'].set(&quot;✅ Not Needed&quot;)
            messagebox.showinfo(&quot;Forward Geocoding Not Needed&quot;, 
                                f&quot;All {total_records} records already have coordinates.&quot;)
            return

        try:
            # Attempt to use the professional ValidationDialog
            from Validation_Dialog import show_validation_dialog
            user_confirmed = show_validation_dialog(self.root, report, &quot;Forward Geocoding&quot;)
        except ImportError:
            # Fallback to standard messagebox if Validation_Dialog.py is missing
            self.log(&quot;⚠️  Validation dialog module not found, using basic fallback&quot;, &quot;WARNING&quot;)
            user_confirmed = messagebox.askyesno(
                &quot;Confirm Processing&quot;,
                f&quot;Validation Passed.

Total Records: {total_records}
&quot;
                f&quot;Missing Coordinates: {missing_coords}

&quot;
                f&quot;Proceed with Forward Geocoding?&quot;
            )
        
        if not user_confirmed:
            self.log(&quot;❌ User canceled processing&quot;)
            self.geo_stats['status'].set(&quot;❌ Canceled&quot;)
            return

        # Step 3: User confirmed - proceed with processing
        self.log(f&quot;
🚀 User confirmed - Processing {missing_coords} records&quot;)
        
        # Update UI Statistics immediately
        self.geo_stats['total'].set(str(total_records))
        self.geo_stats['missing_coords'].set(str(missing_coords))
        self.geo_stats['status'].set(&quot;🔄 Forward Running...&quot;)
        self.pipeline_stats['current_step'].set(&quot;Step 1: Forward Geocoding&quot;)
        
        # Load geocoding engine
        s1_fwd = load_workflow_module(&quot;Forward_Geocode&quot;)
        if not s1_fwd:
            self.geo_stats['status'].set(&quot;❌ Module Error&quot;)
            raise ImportError(&quot;Could not load Forward_Geocode module&quot;)
        
        # Strategy selection
        selected_rank = self.geo_rank_var.get()
        self.log(f&quot;⚙️  Using Strategy: {selected_rank}&quot;)
        
        # Run the engine
        s1_fwd.run(file_path, selected_rank)

        # --- NEW CODE: Run Classification & Proximity ---
        forward_out_path = os.path.join(config.DIR_GEOCODE, &quot;step1_forward_out.xlsx&quot;)
        
        self.log(&quot;🏢 Running Building Classification...&quot;)
        s1_fwd.classify_building_data(forward_out_path, forward_out_path)
        
        self.log(&quot;📍 Running Proximity Flagging...&quot;)
        s1_fwd.flag_close_proximity(forward_out_path, forward_out_path)
        # ------------------------------------------------
        
        # Step 4: Finalize
        self.geo_stats['status'].set(&quot;✅ Forward Complete&quot;)
        self.log(&quot;=&quot; * 70)
        self.log(&quot;✅ FORWARD GEOCODING COMPLETED&quot;)
        self.log(&quot;=&quot; * 70)
        
        messagebox.showinfo(
            &quot;Forward Geocoding Complete&quot;,
            f&quot;✅ Forward geocoding completed successfully!

&quot;
            f&quot;Output file: step1_forward_out.xlsx
&quot;
            f&quot;Location: {config.DIR_GEOCODE}&quot;
        )

    def run_reverse_geocoding(self, file_path):
        &quot;&quot;&quot;Execute Reverse Geocoding Only (Coordinates → Address) with Validation Dialog&quot;&quot;&quot;
        # Check for forward geocoding output first
        forward_output = os.path.join(config.DIR_GEOCODE, &quot;step1_forward_out.xlsx&quot;)
        
        if os.path.exists(forward_output):
            input_file = forward_output
            self.log(f&quot;✓ Found forward geocoding output: {forward_output}&quot;)
        elif file_path and os.path.exists(file_path):
            input_file = file_path
            self.log(f&quot;✓ Using selected file: {file_path}&quot;)
        else:
            raise FileNotFoundError(
                &quot;No input file found!

&quot;
                &quot;Please either:
&quot;
                &quot;1. Run Forward Geocoding first, or
&quot;
                &quot;2. Select a file with coordinates&quot;
            )
        
        self.log(&quot;=&quot; * 70)
        self.log(&quot;📍 REVERSE GEOCODING: Coordinates → Address&quot;)
        self.log(&quot;=&quot; * 70)
        
        # Step 1: Validate Input File
        self.log(&quot;
🔍 Step 1: Validating Input File...&quot;)
        self.geo_stats['status'].set(&quot;🔍 Validating...&quot;)
        
        # Load validator module and validate
        try:
            import pandas as pd
            df = pd.read_excel(input_file)
            
            # Check if coordinates exist
            if 'LATITUDE' not in df.columns or 'LONGITUDE' not in df.columns:
                raise ValueError(&quot;Input file missing LATITUDE or LONGITUDE columns&quot;)
            
            # Count records needing reverse geocoding
            has_coords = (~df['LATITUDE'].isna() & ~df['LONGITUDE'].isna()).sum()
            
            if 'FOUND_ADDRESS' in df.columns:
                needs_address = (df['FOUND_ADDRESS'].isna() & 
                               ~df['LATITUDE'].isna() & 
                               ~df['LONGITUDE'].isna()).sum()
            else:
                needs_address = has_coords
            
            # Build validation report for dialog
            validation_report = {
                'quality': {
                    'total_records': len(df),
                    'missing_address': needs_address,
                    'missing_coords': 0,  # Not relevant for reverse
                    'complete_records': len(df) - needs_address,
                    'pct_missing_address': (needs_address / len(df) * 100) if len(df) > 0 else 0,
                    'pct_missing_coords': 0,
                    'pct_complete': ((len(df) - needs_address) / len(df) * 100) if len(df) > 0 else 0,
                },
                'needs_forward_geocoding': False,
                'needs_reverse_geocoding': needs_address > 0
            }
            
            # Add country distribution if available
            if 'COUNTRY' in df.columns:
                validation_report['quality']['country_distribution'] = df['COUNTRY'].value_counts().to_dict()
            
            self.log(f&quot;
📊 Validation Results:&quot;)
            self.log(f&quot;   Total Records: {len(df)}&quot;)
            self.log(f&quot;   Records with Coordinates: {has_coords}&quot;)
            self.log(f&quot;   Need Reverse Geocoding: {needs_address}&quot;)
            
        except Exception as e:
            self.geo_stats['status'].set(&quot;❌ Validation Failed&quot;)
            raise ValueError(f&quot;Input validation failed: {str(e)}&quot;)
        
        # Show validation dialog and get user confirmation
        self.log(&quot;
📋 Displaying validation results...&quot;)
        
        # Import validation dialog
        try:
            from Validation_Dialog import show_validation_dialog
        except ImportError:
            # Fallback if dialog not available
            self.log(&quot;⚠️  Validation dialog not available, using basic confirmation&quot;)
            
            if needs_address == 0:
                self.log(&quot;
✅ All records already have addresses!&quot;)
                self.geo_stats['status'].set(&quot;✅ Not Needed&quot;)
                messagebox.showinfo(
                    &quot;Reverse Geocoding Not Needed&quot;,
                    f&quot;✅ All records with coordinates already have addresses!

&quot;
                    f&quot;Total records: {len(df)}
&quot;
                    f&quot;Records with coordinates: {has_coords}

&quot;
                    f&quot;You can proceed to Step 2: Building Extraction&quot;
                )
                return
            
            # Simple confirmation
            from tkinter import messagebox
            proceed = messagebox.askyesno(
                &quot;Confirm Reverse Geocoding&quot;,
                f&quot;Validation passed!

&quot;
                f&quot;Records to process: {needs_address}

&quot;
                f&quot;Proceed with Reverse Geocoding?&quot;
            )
            
            if not proceed:
                self.log(&quot;❌ User canceled processing&quot;)
                self.geo_stats['status'].set(&quot;❌ Canceled&quot;)
                return
        else:
            # Show professional validation dialog
            user_confirmed = show_validation_dialog(
                self.root, 
                validation_report, 
                &quot;Reverse Geocoding&quot;
            )
            
            if not user_confirmed:
                self.log(&quot;❌ User canceled processing&quot;)
                self.geo_stats['status'].set(&quot;❌ Canceled&quot;)
                return
        
        # User confirmed - proceed with processing
        self.log(f&quot;
✓ User confirmed - Processing {needs_address} records&quot;)
        self.log(&quot;=&quot; * 70)
        
        # Update statistics
        self.geo_stats['missing_addr'].set(str(needs_address))
        self.geo_stats['filled_rev'].set(&quot;0&quot;)
        
        self.geo_stats['status'].set(&quot;🔄 Reverse Running...&quot;)
        self.pipeline_stats['current_step'].set(&quot;Step 1: Reverse Geocoding&quot;)
        
        # Load reverse geocoding module
        s1_rev = load_workflow_module(&quot;Geocode&quot;)
        
        if not s1_rev:
            raise ImportError(&quot;Could not load Geocode (reverse) module&quot;)
        
        self.log(f&quot;
📁 Processing file: {os.path.basename(input_file)}&quot;)
        self.log(f&quot;🎯 Processing {needs_address} records...&quot;)
        
        # Run reverse geocoding
        s1_rev.run(input_file)
        
        self.geo_stats['status'].set(&quot;✅ Reverse Complete&quot;)
        
        self.log(&quot;=&quot; * 70)
        self.log(&quot;✅ REVERSE GEOCODING COMPLETED&quot;)
        self.log(&quot;=&quot; * 70)
        
        messagebox.showinfo(
            &quot;Reverse Geocoding Complete&quot;,
            f&quot;✅ Reverse geocoding completed successfully!

&quot;
            f&quot;Output file: step1_complete.xlsx
&quot;
            f&quot;Location: {config.DIR_GEOCODE}

&quot;
            f&quot;You can now proceed to Step 2: Building Extraction&quot;
        )

    def run_step_2(self, file_path, mode='all'):
        &quot;&quot;&quot;Execute Step 2: Polygon Extraction&quot;&quot;&quot;
        if not file_path:
            raise ValueError(&quot;No input file selected&quot;)
        
        if not os.path.exists(file_path):
            raise FileNotFoundError(f&quot;Input file not found: {file_path}&quot;)
        
        self.log(&quot;=&quot; * 70)
        self.log(f&quot;📍 STEP 2: BUILDING EXTRACTION ({mode.upper()} MODE)&quot;)
        self.log(&quot;=&quot; * 70)
        
        self.poly_stats['status'].set(&quot;🔄 Running...&quot;)
        self.pipeline_stats['current_step'].set(&quot;Step 2: Extraction&quot;)
        
        s2 = load_workflow_module(&quot;Building_Polygon_Extractor&quot;)
        
        if not s2:
            raise ImportError(&quot;Could not load polygon extraction module&quot;)
        
        self.log(f&quot;🏢 Extracting building footprints...&quot;)
        s2.run(file_path, mode=mode)
        
        self.poly_stats['status'].set(&quot;✅ Complete&quot;)
        self.poly_stats['progress'].set(100)
        self.pipeline_stats['overall_progress'].set(50)
        
        self.log(&quot;=&quot; * 70)
        self.log(&quot;✅ STEP 2 COMPLETED SUCCESSFULLY&quot;)
        self.log(&quot;=&quot; * 70)
    
    def run_step_3(self, _):
        &quot;&quot;&quot;Execute Step 3: Topology Validation&quot;&quot;&quot;
        self.log(&quot;=&quot; * 70)
        self.log(&quot;📍 STEP 3: TOPOLOGY VALIDATION&quot;)
        self.log(&quot;=&quot; * 70)
        
        self.topo_stats['status'].set(&quot;🔄 Running...&quot;)
        self.pipeline_stats['current_step'].set(&quot;Step 3: Validation&quot;)
        
        s3 = load_workflow_module(&quot;Topology&quot;)
        
        if not s3:
            raise ImportError(&quot;Could not load topology validation module&quot;)
        
        self.log(&quot;✓ Validating geometry topology...&quot;)
        s3.run()
        
        self.topo_stats['status'].set(&quot;✅ Complete&quot;)
        self.topo_stats['progress'].set(100)
        self.pipeline_stats['overall_progress'].set(75)
        
        self.log(&quot;=&quot; * 70)
        self.log(&quot;✅ STEP 3 COMPLETED SUCCESSFULLY&quot;)
        self.log(&quot;=&quot; * 70)
    
    def run_step_4(self, _):
        &quot;&quot;&quot;Execute Step 4: Height Analysis&quot;&quot;&quot;
        self.log(&quot;=&quot; * 70)
        self.log(&quot;📍 STEP 4: HEIGHT ANALYSIS&quot;)
        self.log(&quot;=&quot; * 70)
        
        self.height_stats['status'].set(&quot;🔄 Running...&quot;)
        self.pipeline_stats['current_step'].set(&quot;Step 4: Heights&quot;)
        
        validated_file = os.path.join(config.DIR_TOPOLOGY, &quot;Valid_Merged_Polygons.geojson&quot;)
        if not os.path.exists(validated_file):
            raise FileNotFoundError(&quot;No validated polygons found. Run Step 3 first.&quot;)
        
        controller = load_workflow_module(&quot;Height_Analysis_Controller&quot;)
        
        if not controller:
            raise ImportError(&quot;Could not load Height_Analysis_Controller module&quot;)
        
        self.log(&quot;🚀 Starting priority-based height analysis...&quot;)
        controller.run(validated_file)
        
        self.height_stats['status'].set(&quot;✅ Complete&quot;)
        self.height_stats['progress'].set(100)
        self.pipeline_stats['overall_progress'].set(100)
        
        self.log(&quot;=&quot; * 70)
        self.log(&quot;✅ STEP 4 COMPLETED SUCCESSFULLY&quot;)
        self.log(&quot;=&quot; * 70)
    
    def run_full_pipeline(self, file_path):
        &quot;&quot;&quot;Execute all pipeline steps sequentially&quot;&quot;&quot;
        if not file_path:
            raise ValueError(&quot;No input file selected&quot;)
        
        self.log(&quot;=&quot; * 70)
        self.log(&quot;🚀 STARTING FULL AUTOMATED PIPELINE&quot;)
        self.log(&quot;=&quot; * 70)
        
        start_time = time.time()
        
        try:
            # Step 1
            self.log(&quot;
▶ Starting Step 1: Geocoding...&quot;)
            self.run_step_1(file_path)
            
            # Step 2
            step1_output = os.path.join(config.DIR_GEOCODE, &quot;step1_complete.xlsx&quot;)
            if not os.path.exists(step1_output):
                raise FileNotFoundError(&quot;Step 1 output not found&quot;)
            
            self.log(&quot;
▶ Starting Step 2: Polygon Extraction...&quot;)
            self.run_step_2(step1_output, mode='all')
            
            # Step 3
            self.log(&quot;
▶ Starting Step 3: Topology Validation...&quot;)
            self.run_step_3(None)
            
            # Step 4
            self.log(&quot;
▶ Starting Step 4: Height Analysis...&quot;)
            self.run_step_4(None)
            
            # Calculate total time
            elapsed_time = time.time() - start_time
            hours = int(elapsed_time // 3600)
            minutes = int((elapsed_time % 3600) // 60)
            seconds = int(elapsed_time % 60)
            
            self.log(&quot;=&quot; * 70)
            self.log(&quot;✅ FULL PIPELINE COMPLETED SUCCESSFULLY&quot;)
            self.log(f&quot;⏱️  Total execution time: {hours}h {minutes}m {seconds}s&quot;)
            self.log(&quot;=&quot; * 70)
            
            messagebox.showinfo(
                &quot;Success&quot;,
                f&quot;Pipeline completed successfully!

&quot;
                f&quot;Total time: {hours}h {minutes}m {seconds}s

&quot;
                f&quot;Check the output directories for results.&quot;
            )
            
        except Exception as e:
            self.log(f&quot;❌ Pipeline failed: {str(e)}&quot;, &quot;ERROR&quot;)
            raise


# ===========================
# STDOUT REDIRECTOR
# ===========================
class StdoutRedirector:
    &quot;&quot;&quot;Redirects stdout to GUI log queue&quot;&quot;&quot;
    def __init__(self, log_queue):
        self.log_queue = log_queue
    
    def write(self, message):
        if message.strip():
            self.log_queue.put(message.strip())
    
    def flush(self):
        pass


# ===========================
# MAIN ENTRY POINT
# ===========================
if __name__ == &quot;__main__&quot;:
    import multiprocessing
    multiprocessing.freeze_support()
    
    print(&quot;=&quot; * 70)
    print(&quot;   GEOSPATIAL ENTERPRISE PIPELINE v4.0 - PRODUCTION&quot;)
    print(&quot;=&quot; * 70)
    print()
    print(&quot;Initializing enhanced GUI...&quot;)
    
    root = tk.Tk()
    app = GeoPipelineGUI(root)
    
    print(&quot;✅ GUI initialized successfully&quot;)
    print(&quot;Starting main loop...&quot;)
    print(&quot;
⚠️  IMPORTANT: Configure API keys in config.py!&quot;)
    print(&quot;   Use environment variables for security.
&quot;)
    
    root.mainloop()