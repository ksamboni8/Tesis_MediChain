// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Contrato desplegado en Polygon Amoy: 0xa7e1c47b30Ef1a30E3cd46edD2147B4Eed7E6D6A
contract MediChainTriage {
    address public owner;

    struct TriageRecord {
        uint256 id;
        string patientIdAnonymized;
        string dataHash;
        uint8 triageLevel;
        uint256 timestamp;
        address doctor;
        string aiReasoningHash;
    }

    mapping(uint256 => TriageRecord) public records;
    uint256 totalRecords;
    mapping(address => bool) public doctors;
    mapping(address => bool) public auditors;

    event TriageCreated(
        uint256 indexed recordId,
        address indexed doctor,
        uint8 triageLevel,
        uint256 timestamp
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "Solo el propietario puede ejecutar esta funcion");
        _;
    }

    modifier onlyDoctor() {
        require(doctors[msg.sender] || msg.sender == owner, "Acceso restringido a medicos");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function addDoctor(address _doctor) external onlyOwner {
        doctors[_doctor] = true;
    }

    function addAuditor(address _auditor) external onlyOwner {
        auditors[_auditor] = true;
    }

    function isDoctor(address _user) external view returns (bool) {
        return doctors[_user];
    }

    function isAuditor(address _user) external view returns (bool) {
        return auditors[_user];
    }

    function registerTriage(
        string calldata _patientIdAnonymized,
        string calldata _dataHash,
        uint8 _triageLevel,
        string calldata _aiReasoningHash
    ) external onlyDoctor {
        totalRecords++;
        records[totalRecords] = TriageRecord({
            id: totalRecords,
            patientIdAnonymized: _patientIdAnonymized,
            dataHash: _dataHash,
            triageLevel: _triageLevel,
            timestamp: block.timestamp,
            doctor: msg.sender,
            aiReasoningHash: _aiReasoningHash
        });
        emit TriageCreated(totalRecords, msg.sender, _triageLevel, block.timestamp);
    }

    function getLatestRecords(uint256 _limit) external view returns (TriageRecord[] memory) {
        uint256 resultCount = _limit > totalRecords ? totalRecords : _limit;
        TriageRecord[] memory result = new TriageRecord[](resultCount);
        uint256 index = 0;
        for (uint256 i = totalRecords; i > totalRecords - resultCount; i--) {
            result[index] = records[i];
            index++;
        }
        return result;
    }

    function getTotalRecords() external view returns (uint256) {
        return totalRecords;
    }
}
