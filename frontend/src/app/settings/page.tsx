'use client';

import { useState, useEffect } from 'react';
import { useAccount, useReadContract, useWriteContract } from 'wagmi';
import {
  ADDRESSES,
  ARENA_PROFILES_ABI,
  PROFILE_TYPES,
  PROFILE_TYPE_LABELS,
} from '@/lib/contracts';

export default function SettingsPage() {
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();

  // ---- Read existing profile ----
  const { data: profileData, refetch: refetchProfile } = useReadContract({
    address: ADDRESSES.ArenaProfiles,
    abi: ARENA_PROFILES_ABI,
    functionName: 'getProfile',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const profile = profileData as
    | {
        exists: boolean;
        profileType: number;
        avatarHash: string;
        displayName: string;
        bio: string;
        websiteUrl: string;
        createdAt: bigint;
        updatedAt: bigint;
      }
    | undefined;

  const hasProfile = profile?.exists ?? false;

  // ---- Form state ----
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [avatarHash, setAvatarHash] = useState('');
  const [profileType, setProfileType] = useState(0);

  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- Populate form when profile loads ----
  useEffect(() => {
    if (profile?.exists) {
      setDisplayName(profile.displayName);
      setBio(profile.bio);
      setWebsiteUrl(profile.websiteUrl);
      setAvatarHash(
        profile.avatarHash ===
          '0x0000000000000000000000000000000000000000000000000000000000000000'
          ? ''
          : profile.avatarHash,
      );
      setProfileType(Number(profile.profileType));
    }
  }, [profile]);

  // ---- Submit handler ----
  const handleSubmit = async () => {
    if (!address) return;
    setSubmitting(true);
    setError(null);
    setSuccess(false);

    try {
      const avatarBytes =
        avatarHash && avatarHash.length > 0
          ? (avatarHash as `0x${string}`)
          : ('0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`);

      if (hasProfile) {
        await writeContractAsync({
          address: ADDRESSES.ArenaProfiles,
          abi: ARENA_PROFILES_ABI,
          functionName: 'updateProfile',
          args: [displayName, bio, websiteUrl, avatarBytes],
        });
      } else {
        await writeContractAsync({
          address: ADDRESSES.ArenaProfiles,
          abi: ARENA_PROFILES_ABI,
          functionName: 'createProfile',
          args: [profileType, displayName, bio, websiteUrl, avatarBytes],
        });
      }

      setSuccess(true);
      await refetchProfile();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Transaction failed';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  // ---- Not connected ----
  if (!isConnected) {
    return (
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="bg-navy-900 border border-zinc-800 rounded p-12 text-center">
          <p className="text-zinc-400 text-lg">
            Connect your wallet to manage your profile
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <h1 className="text-xl font-mono font-bold text-white mb-2 uppercase tracking-wide">
        {hasProfile ? 'Edit Profile' : 'Create Profile'}
      </h1>
      <p className="text-sm text-zinc-500 mb-6">
        {hasProfile
          ? 'Update your display name, bio, and other details.'
          : 'Set up your Arena profile to get started.'}
      </p>

      {/* Success banner */}
      {success && (
        <div className="mb-6 bg-arena-green/10 border border-arena-green/30 rounded p-4">
          <p className="text-arena-green text-sm font-medium">
            Profile {hasProfile ? 'updated' : 'created'} successfully!
          </p>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="mb-6 bg-arena-red/10 border border-arena-red/30 rounded p-4">
          <p className="text-arena-red text-sm">{error}</p>
        </div>
      )}

      <div className="bg-navy-900 border border-zinc-800 rounded p-6 space-y-6">
        {/* Profile Type (only on create) */}
        {!hasProfile && (
          <div>
            <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-2">
              Profile Type
            </label>
            <div className="flex gap-2">
              {PROFILE_TYPES.map((pt, i) => (
                <button
                  key={pt}
                  onClick={() => setProfileType(i)}
                  className={`px-3 py-2 rounded text-xs font-medium transition-colors ${
                    profileType === i
                      ? 'bg-arena-blue text-white'
                      : 'bg-navy-800 text-zinc-400 hover:text-zinc-200 hover:bg-navy-700'
                  }`}
                >
                  {PROFILE_TYPE_LABELS[i]}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Current type display (on edit) */}
        {hasProfile && (
          <div>
            <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-2">
              Profile Type
            </label>
            <span className="inline-flex px-3 py-1.5 rounded text-xs font-medium bg-navy-800 text-zinc-300">
              {PROFILE_TYPE_LABELS[profileType]}
            </span>
          </div>
        )}

        {/* Display Name */}
        <div>
          <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-2">
            Display Name
          </label>
          <input
            type="text"
            placeholder="Enter your display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={64}
            className="w-full bg-navy-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 font-mono placeholder:text-zinc-600 focus:border-arena-blue focus:outline-none"
          />
          <p className="text-xs text-zinc-600 mt-1">{displayName.length}/64</p>
        </div>

        {/* Bio */}
        <div>
          <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-2">
            Bio
          </label>
          <textarea
            placeholder="Tell us about yourself..."
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={280}
            rows={3}
            className="w-full bg-navy-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-arena-blue focus:outline-none resize-none"
          />
          <p className="text-xs text-zinc-600 mt-1">{bio.length}/280</p>
        </div>

        {/* Website URL */}
        <div>
          <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-2">
            Website URL
          </label>
          <input
            type="text"
            placeholder="https://example.com"
            value={websiteUrl}
            onChange={(e) => setWebsiteUrl(e.target.value)}
            maxLength={128}
            className="w-full bg-navy-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 font-mono placeholder:text-zinc-600 focus:border-arena-blue focus:outline-none"
          />
        </div>

        {/* Avatar Hash */}
        <div>
          <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-2">
            Avatar IPFS Hash
          </label>
          <input
            type="text"
            placeholder="0x... (bytes32 IPFS CID)"
            value={avatarHash}
            onChange={(e) => setAvatarHash(e.target.value)}
            className="w-full bg-navy-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 font-mono placeholder:text-zinc-600 focus:border-arena-blue focus:outline-none"
          />
          <p className="text-xs text-zinc-600 mt-1">
            Leave empty for no avatar
          </p>
        </div>

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={submitting || !displayName}
          className="w-full bg-arena-blue text-white font-medium py-2.5 rounded text-sm hover:bg-arena-blue/90 transition-colors disabled:opacity-50"
        >
          {submitting
            ? 'Submitting...'
            : hasProfile
              ? 'Update Profile'
              : 'Create Profile'}
        </button>
      </div>

      {/* API Keys Section */}
      <ApiKeysSection address={address} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// API Keys management component
// ---------------------------------------------------------------------------
function ApiKeysSection({ address }: { address: string | undefined }) {
  const [keys, setKeys] = useState<
    { key: string; label: string; active: boolean; createdAt: string }[]
  >([]);
  const [newLabel, setNewLabel] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apiBase =
    process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

  // Fetch existing keys
  useEffect(() => {
    if (!address) return;
    fetch(`${apiBase}/api-keys?owner=${address}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.keys) setKeys(data.keys);
      })
      .catch(() => {
        // API may not be running
      });
  }, [address, apiBase]);

  const handleGenerate = async () => {
    if (!address || !newLabel) return;
    setLoading(true);
    setError(null);
    setNewKey(null);

    try {
      const resp = await fetch(`${apiBase}/api-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: newLabel, owner: address }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        setError(data.message ?? 'Failed to generate key');
        return;
      }

      setNewKey(data.key);
      setNewLabel('');

      // Refresh key list
      const listResp = await fetch(`${apiBase}/api-keys?owner=${address}`);
      const listData = await listResp.json();
      if (listData.keys) setKeys(listData.keys);
    } catch {
      setError('Could not connect to API server');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-8">
      <h2 className="text-lg font-mono font-bold text-white mb-2 uppercase tracking-wide">
        API Keys
      </h2>
      <p className="text-sm text-zinc-500 mb-4">
        Generate API keys to interact with The Arena programmatically.
      </p>

      {error && (
        <div className="mb-4 bg-arena-red/10 border border-arena-red/30 rounded p-3">
          <p className="text-arena-red text-sm">{error}</p>
        </div>
      )}

      {newKey && (
        <div className="mb-4 bg-arena-green/10 border border-arena-green/30 rounded p-4">
          <p className="text-arena-green text-sm font-medium mb-1">
            API key generated. Copy it now — it will not be shown again.
          </p>
          <code className="block text-xs font-mono text-arena-green bg-navy-950 rounded px-3 py-2 break-all">
            {newKey}
          </code>
        </div>
      )}

      <div className="bg-navy-900 border border-zinc-800 rounded p-6 space-y-4">
        {/* Generate new key */}
        <div className="flex gap-3">
          <input
            type="text"
            placeholder="Key label (e.g. Production)"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            maxLength={64}
            className="flex-1 bg-navy-950 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 font-mono placeholder:text-zinc-600 focus:border-arena-blue focus:outline-none"
          />
          <button
            onClick={handleGenerate}
            disabled={loading || !newLabel}
            className="px-4 py-2 bg-arena-blue text-white font-medium rounded text-sm hover:bg-arena-blue/90 transition-colors disabled:opacity-50"
          >
            {loading ? 'Generating...' : 'Generate Key'}
          </button>
        </div>

        {/* Existing keys */}
        {keys.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs uppercase tracking-wider text-zinc-500">
              Your Keys
            </h3>
            {keys.map((k, i) => (
              <div
                key={i}
                className="flex items-center justify-between bg-navy-950 border border-zinc-800 rounded px-3 py-2"
              >
                <div>
                  <span className="text-sm text-zinc-300">{k.label}</span>
                  <span className="text-xs text-zinc-600 font-mono ml-3">
                    {k.key}
                  </span>
                </div>
                <span
                  className={`text-xs font-medium ${
                    k.active ? 'text-arena-green' : 'text-zinc-600'
                  }`}
                >
                  {k.active ? 'Active' : 'Revoked'}
                </span>
              </div>
            ))}
          </div>
        )}

        {keys.length === 0 && (
          <p className="text-sm text-zinc-500 text-center py-4">
            No API keys yet
          </p>
        )}
      </div>
    </div>
  );
}
